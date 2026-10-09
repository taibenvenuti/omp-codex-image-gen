// Modified by Oh My Pi contributors from pi-codex-image-gen (Apache-2.0).
/**
 * Project-local Codex image generation extension.
 *
 * Registers inline and artifact image tools that use package-owned ChatGPT
 * image OAuth (or OMP's existing openai-codex login) to call the Codex
 * Responses backend with the native `image_generation` tool. The backend
 * selects the image model.
 */

import { readFileSync } from "node:fs";
import { constants } from "node:fs";
import { mkdir, open, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type {
	AgentToolResult,
	AgentToolUpdateCallback,
	ExtensionAPI,
	ExtensionContext,
} from "@oh-my-pi/pi-coding-agent";
import { extractImageAccountId, imageAuthProvider, IMAGE_AUTH_PROVIDER } from "../src/image-oauth.js";
import { abortable, httpFailure, MAX_IMAGE_BYTES, parseCodexSse, withRequestDeadline, type ParsedCodexResponse } from "../src/codex-response.js";
import { ARTIFACT_ENTRY, RESERVATION_ENTRY, artifactRecord, artifactReservation, readArtifactManifest, branchArtifacts, reserveArtifact, type ImageArtifact, type ImageReservation } from "../src/artifacts.js";

const PACKAGE_NAME = "omp-codex-image-gen";
const LEGACY_PROVIDER = "openai-codex";
const DEFAULT_MODEL = "gpt-6-astra";
const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
const DEFAULT_SAVE_MODE = "global";
const OPENAI_BETA_HEADER = "responses=experimental";
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;
const MAX_RETRY_DELAY_MS = 30_000;
const MAX_EDIT_IMAGES = 5;
const MAX_INPUT_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_INPUT_BYTES = 50 * 1024 * 1024;
const MAX_PROMPT_CHARS = 32_000;

const SAVE_MODES = ["none", "project", "global", "custom"] as const;
type SaveMode = (typeof SAVE_MODES)[number];

const OUTPUT_FORMATS = ["png", "jpeg", "webp"] as const;
type OutputFormat = (typeof OUTPUT_FORMATS)[number];

// --- #1: Retry helpers with exponential backoff + jitter ---

export function parseRetryAfter(value: string | null, nowMs = Date.now()): number | undefined {
	if (!value) return undefined;
	const trimmed = value.trim();
	if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
		const milliseconds = Number(trimmed) * 1000;
		return Number.isFinite(milliseconds) ? Math.min(milliseconds, MAX_RETRY_DELAY_MS) : undefined;
	}
	const dateMs = Date.parse(trimmed);
	if (!Number.isFinite(dateMs) || dateMs <= nowMs) return undefined;
	return Math.min(dateMs - nowMs, MAX_RETRY_DELAY_MS);
}

export function retryDelayMs(
	attempt: number,
	retryAfter: string | null,
	random = Math.random,
	nowMs = Date.now(),
): number {
	const serverDelay = parseRetryAfter(retryAfter, nowMs);
	if (serverDelay !== undefined) {
		return Math.floor(Math.min(serverDelay * (1 + random() * 0.1), MAX_RETRY_DELAY_MS));
	}
	const exponential = Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), MAX_RETRY_DELAY_MS);
	return Math.floor(exponential * (0.9 + random() * 0.2));
}

export function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return Promise.reject(new Error("Image generation was aborted."));
	return new Promise<void>((resolve, reject) => {
		const timer = setTimeout(finish, milliseconds);
		function cleanup() {
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
		}
		function finish() {
			cleanup();
			resolve();
		}
		function abort() {
			cleanup();
			reject(new Error("Image generation was aborted."));
		}
		signal?.addEventListener("abort", abort, { once: true });
	});
}

// --- Tool parameters ---

interface ToolParams {
	prompt: string;
	model?: string;
	outputFormat?: OutputFormat;
	save?: SaveMode;
	saveDir?: string;
	referencedImagePaths?: string[];
	numLastImagesToInclude?: number;
}

// --- Config types ---

interface ExtensionConfig {
	save?: SaveMode;
	saveDir?: string;
	model?: string;
}

interface SaveConfig {
	mode: SaveMode;
	outputDir?: string;
}

interface InputImage {
	data: string;
	mimeType: string;
}

function getAgentDir(): string {
	return resolve(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".omp", "agent"));
}

// --- Image credentials (independent of the active chat provider) ---

interface ImageAuth {
	provider: typeof IMAGE_AUTH_PROVIDER | typeof LEGACY_PROVIDER;
	token: string;
	accountId: string;
}

// Fallback is decided by stored-credential presence, not by whether a token
// resolved: OMP's auth storage returns undefined for a failed refresh, which
// must not silently switch to another account. getOAuthAccess also ignores
// env and API-key credentials, so only OAuth logins are ever used.
async function resolveImageAuth(registry: ExtensionContext["modelRegistry"], sessionId: string, signal?: AbortSignal): Promise<ImageAuth> {
	const storage = registry.authStorage;
	for (const provider of [IMAGE_AUTH_PROVIDER, LEGACY_PROVIDER] as const) {
		if (storage.listOAuthAccounts(provider, sessionId).length === 0) continue;
		let token: string | undefined;
		try {
			token = (await storage.getOAuthAccess(provider, sessionId, { signal }))?.accessToken;
		} catch { /* reported below without exposing the cause */ }
		if (!token) {
			throw new Error(`Image authentication failed for ${provider}. Run /login ${IMAGE_AUTH_PROVIDER} again. No alternate account was used.`);
		}
		return { provider, token, accountId: extractImageAccountId(token) };
	}
	throw new Error(`Missing image OAuth credentials. Run /login ${IMAGE_AUTH_PROVIDER} (or /login openai-codex). API keys and Codex app credentials are not used.`);
}

// --- #10: try/catch readConfigFile replaces racy existsSync + readFileSync ---

function readConfigFile(path: string): ExtensionConfig {
	try {
		return JSON.parse(readFileSync(path, "utf8")) ?? {};
	} catch {
		return {};
	}
}

export function loadConfig(cwd: string, projectTrusted: boolean, agentDir = getAgentDir()): ExtensionConfig {
	const globalConfig = readConfigFile(join(agentDir, "extensions", "codex-image-gen.json"));
	if (!projectTrusted) return globalConfig;
	const projectConfig = readConfigFile(join(cwd, ".omp", "extensions", "codex-image-gen.json"));
	return { ...globalConfig, ...projectConfig };
}

// --- Path helpers ---

export function resolveUnderCwd(cwd: string, path: string, homeDir = homedir()): string {
	if (path === "~") return homeDir;
	if (path.startsWith("~/")) return resolve(homeDir, path.slice(2));
	return isAbsolute(path) ? path : resolve(cwd, path);
}

function sanitizePathPart(value: string, fallback: string): string {
	const sanitized = value.slice(0, 128)
		.split("")
		.map((ch) => (/[a-zA-Z0-9_-]/.test(ch) ? ch : "_"))
		.join("")
		.replace(/_+$/g, "");
	return sanitized || fallback;
}

// --- #5: resolveSaveConfig accepts pre-loaded config (no double loadConfig) ---

function resolveSaveConfig(params: ToolParams, cwd: string, sessionId: string, config: ExtensionConfig): SaveConfig {
	const envMode = process.env.OMP_CODEX_IMAGE_SAVE_MODE?.toLowerCase();
	const mode = (params.save || envMode || config.save || DEFAULT_SAVE_MODE) as SaveMode;
	const safeSessionId = sanitizePathPart(sessionId, "session");
	if (!SAVE_MODES.includes(mode)) {
		throw new Error(`Invalid save mode: ${mode}. Expected one of ${SAVE_MODES.join(", ")}.`);
	}
	if (mode === "project") {
		return { mode, outputDir: join(cwd, ".omp", "generated-images", safeSessionId) };
	}
	if (mode === "global") {
		return { mode, outputDir: join(getAgentDir(), "generated-images", safeSessionId) };
	}
	if (mode === "custom") {
		const configuredDir = params.saveDir || process.env.OMP_CODEX_IMAGE_SAVE_DIR || config.saveDir;
		if (!configuredDir || !configuredDir.trim()) {
			throw new Error("save=custom requires saveDir or OMP_CODEX_IMAGE_SAVE_DIR.");
		}
		return { mode, outputDir: join(resolveUnderCwd(cwd, configuredDir), safeSessionId) };
	}
	return { mode };
}

// --- Image save helpers ---

function extensionForFormat(outputFormat: OutputFormat): string {
	return outputFormat === "jpeg" ? "jpg" : outputFormat;
}

function mimeForFormat(outputFormat: OutputFormat): string {
	return outputFormat === "jpeg" ? "image/jpeg" : `image/${outputFormat}`;
}

function imagePath(outputFormat: OutputFormat, outputDir: string, imageCallId: string): string {
	const filename = `${sanitizePathPart(imageCallId, "image_generation")}.${extensionForFormat(outputFormat)}`;
	return join(outputDir, filename);
}

export function decodeImageData(base64Data: string, outputFormat: OutputFormat): Buffer {
	if (base64Data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) throw new Error("Codex image exceeded the 32 MiB size limit.");
	const value = base64Data.trim();
	if (!value || value.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(value)) {
		throw new Error("Codex returned invalid base64 image data.");
	}
	const bytes = Buffer.from(value, "base64");
	if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES || bytes.toString("base64") !== value) {
		throw new Error("Codex returned invalid base64 image data.");
	}
	const validSignature =
		(outputFormat === "png" && bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) ||
		(outputFormat === "jpeg" && bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) ||
		(outputFormat === "webp" && bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP");
	if (!validSignature) throw new Error(`Codex returned image data that does not match ${outputFormat}.`);
	return bytes;
}

async function saveImage(
	bytes: Buffer,
	outputFormat: OutputFormat,
	outputDir: string,
	imageCallId: string,
): Promise<string> {
	const filePath = imagePath(outputFormat, outputDir, imageCallId);
	await mkdir(outputDir, { recursive: true, mode: 0o700 });
	await writeFile(filePath, bytes, { flag: "wx", mode: 0o600 });
	return filePath;
}

type RecentImage = InputImage | { path: string; mimeType: string };

export function selectRecentImages(messages: unknown[], count: number): RecentImage[] {
	const images: RecentImage[] = [];
	for (let index = messages.length - 1; index >= 0 && images.length < count; index--) {
		const message = messages[index] as { content?: unknown };
		if (!Array.isArray(message?.content)) continue;
		for (let contentIndex = message.content.length - 1; contentIndex >= 0 && images.length < count; contentIndex--) {
			const block = message.content[contentIndex] as { type?: unknown; data?: unknown; mimeType?: unknown; path?: unknown };
			if (block?.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string") {
				images.push({ data: block.data, mimeType: block.mimeType });
			} else if (block?.type === "image_artifact" && typeof block.path === "string" && typeof block.mimeType === "string") {
				images.push({ path: block.path, mimeType: block.mimeType });
			}
		}
	}
	return images.reverse();
}

function mimeFromBytes(bytes: Buffer, path: string): string {
	if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
	if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
	if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp";
	throw new Error(`Referenced image is unavailable or unsupported: ${path}`);
}

async function readInputImage(path: string): Promise<Buffer> {
	// O_NONBLOCK prevents named pipes from blocking before the regular-file check.
	const file = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
	try {
		const info = await file.stat();
		if (!info.isFile()) throw new Error("Referenced images must be regular files.");
		if (info.size > MAX_INPUT_IMAGE_BYTES) throw new Error("Referenced image exceeds 20 MiB.");
		const blocks: Buffer[] = [];
		let total = 0;
		while (true) {
			const block = Buffer.alloc(Math.min(64 * 1024, MAX_INPUT_IMAGE_BYTES + 1 - total));
			const { bytesRead } = await file.read(block, 0, block.length, null);
			if (!bytesRead) break;
			total += bytesRead;
			if (total > MAX_INPUT_IMAGE_BYTES) throw new Error("Referenced image exceeds 20 MiB.");
			blocks.push(block.subarray(0, bytesRead));
		}
		return Buffer.concat(blocks, total);
	} finally {
		await file.close();
	}
}

export async function resolveInputImages(
	params: ToolParams,
	cwd: string,
	messages: unknown[],
): Promise<InputImage[]> {
	const paths = params.referencedImagePaths ?? [];
	const count = params.numLastImagesToInclude === 0 ? undefined : params.numLastImagesToInclude; // OMP serializes an omitted optional numeric parameter as 0.
	if (paths.length > 0 && count !== undefined) {
		throw new Error("Provide only one of referencedImagePaths or numLastImagesToInclude.");
	}
	if (paths.length > MAX_EDIT_IMAGES) throw new Error(`referencedImagePaths accepts at most ${MAX_EDIT_IMAGES} paths.`);
	if (paths.length > 0) {
		const images: InputImage[] = [];
		let total = 0;
		for (const path of paths) {
			const normalized = path.startsWith("@") ? path.slice(1) : path;
			const absolutePath = resolveUnderCwd(cwd, normalized);
			let bytes: Buffer;
			try {
				bytes = await readInputImage(absolutePath);
			} catch (error) {
				throw new Error(`Unable to read referenced image at ${absolutePath}: ${error instanceof Error ? error.message : String(error)}`);
			}
			total += bytes.length;
			if (total > MAX_TOTAL_INPUT_BYTES) throw new Error("Referenced images exceed 50 MiB in total.");
			images.push({ data: bytes.toString("base64"), mimeType: mimeFromBytes(bytes, absolutePath) });
		}
		return images;
	}
	if (count !== undefined) {
		if (!Number.isInteger(count) || count < 1 || count > MAX_EDIT_IMAGES) {
			throw new Error(`numLastImagesToInclude must be between 1 and ${MAX_EDIT_IMAGES}.`);
		}
		const recent = selectRecentImages(messages, count);
		if (recent.length !== count) {
			throw new Error(`Requested the last ${count} conversation images, but only ${recent.length} were available.`);
		}
		const images: InputImage[] = [];
		let total = 0;
		for (const selected of recent) {
			const image = "path" in selected
				? { data: (await readInputImage(selected.path)).toString("base64"), mimeType: selected.mimeType }
				: selected;
			if (image.data.length > Math.ceil(MAX_INPUT_IMAGE_BYTES / 3) * 4) throw new Error("Conversation image exceeds 20 MiB.");
			const format = OUTPUT_FORMATS.find(format => mimeForFormat(format) === image.mimeType);
			if (!format) throw new Error("Conversation image has an unsupported format.");
			const bytes = decodeImageData(image.data, format);
			if (bytes.length > MAX_INPUT_IMAGE_BYTES) throw new Error("Conversation image exceeds 20 MiB.");
			total += bytes.length;
			if (total > MAX_TOTAL_INPUT_BYTES) throw new Error("Conversation images exceed 50 MiB in total.");
			images.push(image);
		}
		return images;
	}
	return [];
}

// --- Request building ---
// #2: prompt_cache_key set to sessionId
// #7: parallel_tool_calls: false
// #14: include removed (not needed without reasoning)

export function buildRequestBody(
	params: ToolParams,
	model: string,
	outputFormat: OutputFormat,
	sessionId: string,
	inputImages: InputImage[] = [],
) {
	return {
		model,
		store: false,
		stream: true,
		prompt_cache_key: sessionId,
		instructions:
			"You are generating bitmap image assets. For this request, call the image_generation tool exactly once. Do not answer with only text unless image generation is unavailable.",
		input: [
			{
				role: "user",
				content: [
					{ type: "input_text", text: params.prompt },
					...inputImages.map((image) => ({
						type: "input_image",
						image_url: `data:${image.mimeType};base64,${image.data}`,
					})),
				],
			},
		],
		tools: [{ type: "image_generation", output_format: outputFormat }],
		tool_choice: "auto",
		parallel_tool_calls: false,
		text: { verbosity: "low" },
	};
}

// --- #1: requestImage with retry + backoff + jitter ---

async function requestImage(
	params: ToolParams,
	auth: ImageAuth,
	model: string,
	outputFormat: OutputFormat,
	sessionId: string,
	inputImages: InputImage[],
	signal?: AbortSignal,
	onProgress?: (stage: string) => void,
): Promise<ParsedCodexResponse> {
	const body = JSON.stringify(buildRequestBody(params, model, outputFormat, sessionId, inputImages));
	const headers: Record<string, string> = {
		Authorization: `Bearer ${auth.token}`,
		"chatgpt-account-id": auth.accountId,
		originator: "pi",
		"User-Agent": PACKAGE_NAME,
		"OpenAI-Beta": OPENAI_BETA_HEADER,
		accept: "text/event-stream",
		"content-type": "application/json",
	};

	return withRequestDeadline(signal, async (signal) => {
		for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
			signal.throwIfAborted();
			let response: Response;
			try {
				response = await abortable(fetch(CODEX_RESPONSES_URL, {
					method: "POST", headers, body, signal, redirect: "error",
				}), signal);
			} catch {
				signal.throwIfAborted();
				throw new Error("Codex connection failed. No automatic retry was made; check connectivity before trying again.");
			}

			if (!response.ok) {
				const failure = await httpFailure(response, signal);
				if (attempt <= MAX_RETRIES && failure.retry) {
					const delay = retryDelayMs(attempt, response.headers.get("retry-after"));
					await abortableDelay(delay, signal);
					continue;
				}
				throw new Error(failure.message);
			}

			return parseCodexSse(response, signal, [auth.token, auth.accountId], onProgress);
		}
		throw new Error("Codex image generation request failed after all retries.");
	});
}

// --- Extension entry point ---

export default function codexImageGen(omp: ExtensionAPI) {
	const type = omp.arktype;
	const TOOL_PARAMS = type({
		prompt: type("string").atLeastLength(1).atMostLength(MAX_PROMPT_CHARS).describe(
			"The image prompt. Be specific about subject, composition, style, text, and constraints.",
		),
		"model?": type("string").atLeastLength(1).atMostLength(200).describe(`Codex routing model, not an image model selector. Defaults to ${DEFAULT_MODEL}.`),
		"outputFormat?": type("'png' | 'jpeg' | 'webp'"),
		"save?": type("'none' | 'project' | 'global' | 'custom'"),
		"saveDir?": type("string").describe(
			"Directory to save the image when save=custom. Relative paths resolve under the current workspace.",
		),
		"referencedImagePaths?": type("string[]")
			.atMostLength(MAX_EDIT_IMAGES)
			.describe("Up to five local image paths to edit. Relative paths resolve under the current workspace."),
		"numLastImagesToInclude?": type("number.integer").describe(
			"Use the most recent one to five images from the current conversation as edit inputs.",
		),
	});
	omp.registerProvider(IMAGE_AUTH_PROVIDER, imageAuthProvider);

	const guidelines = [
		"Generate or edit images only on a clear user request; each call consumes Codex image quota.",
		"The model parameter selects a Codex routing model, not an image model. Do not pass gpt-image-* IDs.",
		"Output metadata is backend-reported. Inspect pixels for dimensions and transparency; do not infer a served model.",
		"Do not automatically repeat quota, connection, deadline, incomplete-stream, or artifact-storage failures. Quota may already have been consumed.",
	].join(" ");

	async function recordOriginal(
		artifact: ImageArtifact, toolCallId: string, reservation: ImageReservation,
		ctx: ExtensionContext, sessionId: string, originEntryId: string | null,
	): Promise<string | undefined> {
		const record = { artifact, toolCallId: toolCallId.slice(0, 256) };
		let manifestPublished = false;
		try {
			await reservation.publish(record);
			manifestPublished = true;
		} catch { /* A completed original must survive a metadata-storage failure. */ }
		// Do not attach late results to an unrelated branch or a replacement
		// session. The pre-generation reservation and private manifest preserve
		// recovery on the originating branch, including its forks and resumes.
		try {
			if (ctx.sessionManager.getSessionId() === sessionId && originEntryId
				&& ctx.sessionManager.getBranch().some(entry => entry.id === originEntryId)) {
				omp.appendEntry(ARTIFACT_ENTRY, record);
				return undefined;
			}
		} catch { /* The context may be inactive after reload; use the manifest. */ }
		if (manifestPublished) return undefined;
		return `Artifact recovery metadata could not be persisted. Recover the image from ${artifact.path}. No generation retry was made.`;
	}

	async function executeImage(
		artifactMode: boolean, toolCallId: string, params: ToolParams, signal: AbortSignal | undefined,
		onUpdate: AgentToolUpdateCallback<unknown> | undefined, ctx: ExtensionContext,
	): Promise<AgentToolResult<unknown>> {
		let reservation: ImageReservation | undefined;
		let originEntryId: string | null = null;
		try {
			if (typeof params.prompt !== "string" || !params.prompt.trim() || params.prompt.length > MAX_PROMPT_CHARS) {
				throw new Error("Image prompt must contain 1 to 32,000 characters.");
			}
			const outputFormat = params.outputFormat || "png";
			if (!OUTPUT_FORMATS.includes(outputFormat)) throw new Error("Unsupported image output format.");
			const projectTrusted = typeof ctx.isProjectTrusted === "function" && ctx.isProjectTrusted();
			const config = loadConfig(ctx.cwd, projectTrusted); // #5: load once, pass to resolveSaveConfig
			const requestedModel = params.model || config.model || DEFAULT_MODEL;
			if (typeof requestedModel !== "string" || !requestedModel.trim() || requestedModel.length > 200) {
				throw new Error("Codex routing model must contain 1 to 200 characters.");
			}
			if (requestedModel.startsWith("gpt-image-")) {
				throw new Error("The model parameter selects a Codex routing model, not an image model. Subscription image-model selection is not verified.");
			}
			const sessionId = ctx.sessionManager.getSessionId();
			const saveConfig = resolveSaveConfig(params, ctx.cwd, sessionId, config);
			const messages: unknown[] = [];
			const branch = ctx.sessionManager.getBranch();
			const completedPaths = new Set(branch.flatMap(entry => {
				const record = entry.type === "custom" && entry.customType === ARTIFACT_ENTRY ? artifactRecord(entry.data) : undefined;
				return record ? [record.artifact.path] : [];
			}));
			for (const entry of params.numLastImagesToInclude !== undefined ? branch : []) {
				if (entry.type === "message") messages.push(entry.message);
				if (entry.type === "custom_message") messages.push(entry);
				if (entry.type === "custom" && entry.customType === ARTIFACT_ENTRY) {
					const record = artifactRecord(entry.data);
					if (record) messages.push({ content: [{ type: "image_artifact", ...record.artifact }] });
				}
				if (entry.type === "custom" && entry.customType === RESERVATION_ENTRY) {
					const pending = artifactReservation(entry.data);
					const record = pending ? await readArtifactManifest(pending) : undefined;
					// Normal completions also have a session entry. Prefer that
					// later entry and avoid counting the same original twice.
					if (record && !completedPaths.has(record.artifact.path)) {
						messages.push({ content: [{ type: "image_artifact", ...record.artifact }] });
					}
				}
			}
			const inputImages = await resolveInputImages(params, ctx.cwd, messages);
			signal?.throwIfAborted();
			if (artifactMode) {
				try {
					reservation = await reserveArtifact(extensionForFormat(outputFormat));
				} catch {
					throw new Error("Image artifact storage is unavailable. No generation request was made.");
				}
				signal?.throwIfAborted();
				// Attach the recovery anchor synchronously before quota/network
				// work. A cancelled parent may settle while commit I/O is pending.
				omp.appendEntry(RESERVATION_ENTRY, {
					path: reservation.path, mimeType: mimeForFormat(outputFormat), toolCallId: toolCallId.slice(0, 256),
				});
				originEntryId = ctx.sessionManager.getLeafId();
			}
			const auth = await resolveImageAuth(ctx.modelRegistry, sessionId, signal);
			const provider = auth.provider;
			const model = ctx.modelRegistry.find(provider, requestedModel)?.id || requestedModel;

			onUpdate?.({
				content: [{ type: "text", text: `Requesting image ${inputImages.length > 0 ? "edit" : "generation"} through ${provider}/${model}...` }],
				details: { provider, model, outputFormat, inputImageCount: inputImages.length },
			});

			const started = Date.now();
			const parsed = await requestImage(params, auth, model, outputFormat, sessionId, inputImages, signal, (stage) => {
				onUpdate?.({
					content: [{ type: "text", text: `Codex image stage: ${stage}.` }],
					details: { provider, model, stage },
				});
			});
			if (!parsed.image) {
				const text = parsed.text.join("").trim();
				throw new Error(text ? `Codex did not return an image. Response text: ${text}` : "Codex did not return an image.");
			}

			const imageBytes = decodeImageData(parsed.image.result, outputFormat);
			const reportedImage = parsed.image.reported;
			let savedPath: string | undefined;
			let attemptedPath: string | undefined;
			let saveWarning: string | undefined;
			let artifact: ImageArtifact | undefined;
			let recoveryWarning: string | undefined;
			if (reservation) {
				try {
					artifact = await reservation.commit(imageBytes, mimeForFormat(outputFormat));
				} catch {
					// Attempt the requested persistent copy below, never generation again.
				}
				// Persist before callbacks, persistent saves, or parent script output.
				if (artifact) recoveryWarning = await recordOriginal(artifact, toolCallId, reservation, ctx, sessionId, originEntryId);
			}
			if (saveConfig.mode !== "none" && saveConfig.outputDir) {
				attemptedPath = imagePath(outputFormat, saveConfig.outputDir, parsed.image.id || toolCallId);
				try {
					savedPath = await saveImage(imageBytes, outputFormat, saveConfig.outputDir, parsed.image.id || toolCallId);
				} catch (error) {
					const reason = (error instanceof Error ? error.message : String(error))
						.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").slice(0, 500);
					saveWarning = `Image generation succeeded, but the image could not be saved to disk: ${reason}`;
				}
			}
			if (artifactMode && !artifact) {
				if (savedPath) {
					artifact = { path: savedPath, mimeType: mimeForFormat(outputFormat), byteCount: imageBytes.length };
					recoveryWarning = await recordOriginal(artifact, toolCallId, reservation!, ctx, sessionId, originEntryId);
					saveWarning = "Temporary artifact storage failed; recover the original from the persistent saved path. No generation retry was made.";
				} else {
					throw new Error("Image generation succeeded, but artifact storage failed and no usable file could be saved. Image quota may have been consumed. No automatic retry was made.");
				}
			}
			saveWarning = [saveWarning, recoveryWarning].filter(Boolean).join(" ") || undefined;

			const summary = [
				`Generated image via ${provider}/${model} using the backend-selected image model.`,
				`Status: ${parsed.image.status}.`,
				reportedImage.size ? `Backend-reported size: ${reportedImage.size}.` : undefined,
				reportedImage.quality ? `Backend-reported quality: ${reportedImage.quality}.` : undefined,
				reportedImage.background ? `Backend-reported background: ${reportedImage.background}.` : undefined,
				parsed.image.revisedPrompt ? `Revised prompt: ${parsed.image.revisedPrompt}` : undefined,
				artifact ? `Original image artifact: ${artifact.path}.` : undefined,
				savedPath ? `Saved image to: ${savedPath}` : artifactMode ? "No persistent image copy was saved." : "Image was not saved to disk.",
				saveWarning ? `Warning: ${saveWarning}` : undefined,
			]
				.filter(Boolean)
				.join(" ");

			if (savedPath || artifact) onUpdate?.({
				content: [{ type: "text", text: artifact ? `Original image artifact: ${artifact.path}.` : `Image saved to ${savedPath}.` }],
				details: { provider, model, savedPath, artifact, byteCount: imageBytes.length },
			});

			return {
				content: [
					{ type: "text", text: summary },
					...(!artifactMode ? [{ type: "image" as const, data: parsed.image.result, mimeType: mimeForFormat(outputFormat) }] : []),
				],
				details: {
					provider,
					model,
					backendImageModel: reportedImage.model ?? "unknown",
					reportedImage,
					transport: "codex-responses",
					generationDurationMs: Date.now() - started,
					byteCount: imageBytes.length,
					outputFormat,
					saveMode: saveConfig.mode,
					savedPath,
					artifact,
					attemptedPath,
					saveWarning,
					inputImageCount: inputImages.length,
					responseId: parsed.responseId,
					imageGenerationId: parsed.image.id,
					revisedPrompt: parsed.image.revisedPrompt,
					usage: parsed.usage,
				},
			};
		} finally {
			// Cleanup only reservations made by this call, never completed originals.
			await reservation?.dispose().catch(() => undefined);
		}
	}

	const description = `Generate or edit an image with the OpenAI Codex ChatGPT backend built-in image_generation tool. The backend selects the image model. Accepts up to five local or recent conversation images (20 MiB each, 50 MiB total). Requires /login ${IMAGE_AUTH_PROVIDER} or an existing OMP openai-codex login; does not require an API key. Network deadline: 5 minutes; output image limit: 32 MiB; backend text is limited to 4,000 characters. ${guidelines}`;
	omp.registerTool({
		name: "codex_generate_image",
		label: "Codex Image",
		description: `${description} Returns an inline image.`,
		parameters: TOOL_PARAMS,
		loadMode: "essential",
		approval: "write",
		execute: (id, params: ToolParams, signal, update, ctx) => executeImage(false, id, params, signal, update, ctx),
	});
	omp.registerTool({
		name: "codex_generate_image_artifact",
		label: "Codex Image Artifact",
		description: `${description} Returns metadata (details.artifact) and a private temporary original path, never image bytes. save=none disables persistent copies, not temporary storage. Completed artifacts survive errors and reload until user/OS cleanup. For chained edits pass the artifact path through referencedImagePaths; each edit consumes quota. Recover current-branch paths with /image-artifacts.`,
		parameters: TOOL_PARAMS,
		approval: "write",
		execute: (id, params: ToolParams, signal, update, ctx) => executeImage(true, id, params, signal, update, ctx),
	});
	omp.registerCommand("image-artifacts", {
		description: "List the last 20 generated original artifact paths on the current branch (no generation).",
		handler: async (_args, ctx) => {
			const records = (await branchArtifacts(ctx.sessionManager.getBranch())).slice(-20);
			omp.sendMessage({
				customType: "codex-image-artifact-list",
				content: records.length ? records.map(record =>
					`${record.artifact.path} (${record.artifact.mimeType}, ${record.artifact.byteCount} bytes)`,
				).join("\n") + "\nTemporary originals may be removed by user/OS cleanup. Copy needed assets to persistent storage."
					: "No image artifacts recorded on this branch.",
				display: true,
			});
		},
	});
}
