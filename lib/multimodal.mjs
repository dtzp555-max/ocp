// OCP multimodal helpers — OpenAI `image_url` content parts → Anthropic image
// blocks fed to `claude -p --input-format stream-json`. (issue #110)
//
// Class B.1 (OpenAI-compatibility surface). Protocol authority is OpenAI's
// chat/completions spec — the multimodal `content` parts shape
// (https://platform.openai.com/docs/guides/vision and
// https://platform.openai.com/docs/api-reference/chat/create#chat-create-messages,
// `image_url` part with `image_url.url` = data URI or http(s) URL). Authorized
// by ADR 0006. This module introduces NO field beyond OpenAI's published shape:
// the OpenAI-side vocabulary read here is `type:"image_url"` +
// `image_url:{url, detail?}`; the Anthropic-side vocabulary written here
// (`type:"image", source:{type:"base64"|"url", ...}`) is the CLI's native
// stream-json input contract, not an OCP invention.
//
// Kept as a pure module (no I/O, no network, no process state) mirroring the
// lib/*.mjs pattern so it is unit-testable without a live server. server.mjs is
// the only consumer; it owns spawning, caps configuration, and HTTP status.

// Anthropic vision-supported image media types. A data URI whose media type is
// outside this set is rejected with a clear 4xx rather than forwarded (the API
// would reject it anyway; failing early gives a better error).
export const SUPPORTED_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

// Default caps. server.mjs overrides these from env; they live here so the
// pure transform is self-contained and testable.
export const DEFAULT_MULTIMODAL_OPTS = {
  allowRemoteUrl: false,        // http(s) image URLs are OFF by default (v1: data URIs only)
  maxImageBytes: 5 * 1024 * 1024,   // per-image decoded-byte cap
  maxImages: 20,                // max image parts across the whole request
  maxTotalImageBytes: 20 * 1024 * 1024, // aggregate decoded-byte cap
};

// Typed error so server.mjs can map to the right HTTP status + OpenAI-shaped
// error body. `status` is the HTTP code; `type` is the OpenAI error `type`.
export class MultimodalError extends Error {
  constructor(code, status, message) {
    super(message);
    this.name = "MultimodalError";
    this.code = code;
    this.status = status;
    this.type = "invalid_request_error"; // OpenAI error `type` for 4xx client errors
  }
}

// True if any message carries an OpenAI `image_url` content part. Cheap guard so
// the byte-for-byte text path is only left when an image is genuinely present.
export function hasImageContent(messages) {
  if (!Array.isArray(messages)) return false;
  for (const m of messages) {
    if (m && Array.isArray(m.content)) {
      for (const part of m.content) {
        if (part && part.type === "image_url") return true;
      }
    }
  }
  return false;
}

// Extract the URL string from an OpenAI image_url part. Spec form is
// `{type:"image_url", image_url:{url, detail?}}`; many OpenAI-compatible clients
// also send `image_url` as a bare string. Accept both (input leniency — no new
// output field). `detail` (auto|low|high) is OpenAI-only and has no Anthropic
// analogue, so it is read-and-ignored.
function imageUrlOf(part) {
  const iu = part.image_url;
  if (typeof iu === "string") return iu;
  if (iu && typeof iu.url === "string") return iu.url;
  return null;
}

// Parse a base64 data URI: `data:[<media_type>][;base64],<data>`.
// Returns { mediaType, data (base64), bytes (decoded size) } or throws MultimodalError.
function parseDataUri(uri) {
  const comma = uri.indexOf(",");
  if (comma === -1) {
    throw new MultimodalError("invalid_data_uri", 400, "Malformed image data URI (no comma).");
  }
  const meta = uri.slice(5, comma); // strip leading "data:"
  const segs = meta.split(";");
  const mediaType = (segs[0] || "").trim().toLowerCase();
  const isBase64 = segs.slice(1).some((s) => s.trim().toLowerCase() === "base64");
  if (!isBase64) {
    throw new MultimodalError("invalid_data_uri", 400, "Only base64-encoded image data URIs are supported.");
  }
  if (!SUPPORTED_IMAGE_TYPES.has(mediaType)) {
    throw new MultimodalError(
      "unsupported_image_type",
      400,
      `Unsupported image media type '${mediaType || "(none)"}'. Supported: ${[...SUPPORTED_IMAGE_TYPES].join(", ")}.`
    );
  }
  // Strip incidental whitespace/newlines some encoders insert into data URIs.
  const data = uri.slice(comma + 1).replace(/\s/g, "");
  if (data.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) {
    throw new MultimodalError("invalid_data_uri", 400, "Image data URI payload is not valid base64.");
  }
  // Decoded size from base64 length (minus padding); avoids decoding the buffer
  // just to measure it.
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  const bytes = Math.floor((data.length * 3) / 4) - padding;
  return { mediaType, data, bytes };
}

// Convert a single OpenAI image_url part to an Anthropic image block, enforcing
// caps via the mutable `acc` accumulator ({ images, bytes }). Throws MultimodalError.
function imagePartToBlock(part, opts, acc) {
  const url = imageUrlOf(part);
  if (!url) {
    throw new MultimodalError("invalid_image_url", 400, "image_url part is missing a URL.");
  }

  acc.images += 1;
  if (acc.images > opts.maxImages) {
    throw new MultimodalError("too_many_images", 413, `Too many images in request (max ${opts.maxImages}).`);
  }

  if (url.startsWith("data:")) {
    const { mediaType, data, bytes } = parseDataUri(url);
    if (bytes > opts.maxImageBytes) {
      throw new MultimodalError("image_too_large", 413, `Image exceeds per-image size limit (${opts.maxImageBytes} bytes).`);
    }
    acc.bytes += bytes;
    if (acc.bytes > opts.maxTotalImageBytes) {
      throw new MultimodalError("images_too_large", 413, `Total image payload exceeds limit (${opts.maxTotalImageBytes} bytes).`);
    }
    return { type: "image", source: { type: "base64", media_type: mediaType, data } };
  }

  if (/^https?:\/\//i.test(url)) {
    if (!opts.allowRemoteUrl) {
      throw new MultimodalError(
        "remote_url_disabled",
        400,
        "Remote image URLs are disabled. Enable CLAUDE_IMAGE_ALLOW_URL=1 to allow http(s) image URLs, or pass the image as a base64 data URI."
      );
    }
    // Passthrough as an Anthropic url-source block. OCP does NOT fetch the URL
    // itself (no OCP-side SSRF surface); the fetch is performed upstream by the
    // Anthropic API. Best-effort: unreachable/blocked URLs surface as an API error.
    return { type: "image", source: { type: "url", url } };
  }

  throw new MultimodalError("unsupported_url_scheme", 400, "image_url must be a base64 data URI or an http(s) URL.");
}

// Role prefix mirrors messagesToPrompt()'s text-path labeling so a multi-turn
// conversation reads the same whether or not it carries images. System messages
// are handled by the caller via --system-prompt and never reach here.
function rolePrefix(role) {
  if (role === "assistant") return "[Assistant] ";
  return ""; // user / tool / anything else: verbatim, as in the text path
}

// Build the Anthropic content-block array for a single stream-json user
// envelope. Mirrors the text path's "collapse the whole conversation into one
// turn passed via stdin" model (OCP runs stateless, full context per spawn), but
// preserves image position relative to text and keeps images out of the text
// char budget entirely. Returns { blocks, stats } or throws MultimodalError.
export function buildImageBlocks(messages, opts = {}) {
  const o = { ...DEFAULT_MULTIMODAL_OPTS, ...opts };
  const blocks = [];
  const acc = { images: 0, bytes: 0 };
  let textChars = 0;
  let firstMessage = true;

  const pushText = (text) => {
    if (!text) return;
    blocks.push({ type: "text", text });
    textChars += text.length;
  };

  for (const m of messages) {
    const prefix = rolePrefix(m.role);
    // Separate messages with a blank line, matching messagesToPrompt's "\n\n" join.
    const sep = firstMessage ? "" : "\n\n";
    firstMessage = false;
    let prefixEmitted = false;
    const emitPrefixWith = (t) => {
      if (prefixEmitted) return t;
      prefixEmitted = true;
      return sep + prefix + t;
    };

    if (typeof m.content === "string") {
      pushText(emitPrefixWith(m.content));
      continue;
    }
    if (!Array.isArray(m.content)) {
      // null / object content: mirror contentToText's fallback.
      const t = m.content == null ? "" : JSON.stringify(m.content);
      pushText(emitPrefixWith(t));
      continue;
    }

    for (const part of m.content) {
      if (part && part.type === "text" && typeof part.text === "string") {
        pushText(emitPrefixWith(part.text));
      } else if (part && part.type === "image_url") {
        // Ensure the role prefix isn't lost when a message leads with an image.
        if (!prefixEmitted && prefix) pushText(emitPrefixWith(""));
        blocks.push(imagePartToBlock(part, o, acc));
      } else {
        // audio / file / unknown parts: preserve the existing placeholder
        // behavior (issue #110) — deferred to a future version.
        pushText(emitPrefixWith("[non-text content omitted]"));
      }
    }
  }

  // Defensive: a stream-json user turn must have at least one content block.
  if (blocks.length === 0) blocks.push({ type: "text", text: "" });

  return {
    blocks,
    stats: { imageCount: acc.images, totalImageBytes: acc.bytes, textChars },
  };
}

// Serialize the non-system conversation to a single newline-terminated
// stream-json user message for `claude -p --input-format stream-json` stdin.
// Returns { payload, stats } or throws MultimodalError.
export function buildStreamJsonInput(messages, opts = {}) {
  const { blocks, stats } = buildImageBlocks(messages, opts);
  const envelope = { type: "user", message: { role: "user", content: blocks } };
  return { payload: JSON.stringify(envelope) + "\n", stats };
}
