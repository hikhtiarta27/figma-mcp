#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import WebSocket from "ws";
import { v4 as uuidv4 } from "uuid";

interface FigmaResponse {
  id: string;
  result?: unknown;
  error?: string;
}

interface CommandProgressUpdate {
  type: "command_progress";
  commandId: string;
  commandType: string;
  status: "started" | "in_progress" | "completed" | "error";
  progress: number;
  totalItems: number;
  processedItems: number;
  message: string;
  payload?: unknown;
  timestamp: number;
}

interface RelayChannel {
  name: string;
  clientCount: number;
  description?: string;
}

const logger = {
  info: (message: string) => process.stderr.write(`[INFO] ${message}\n`),
  debug: (message: string) => process.stderr.write(`[DEBUG] ${message}\n`),
  warn: (message: string) => process.stderr.write(`[WARN] ${message}\n`),
  error: (message: string) => process.stderr.write(`[ERROR] ${message}\n`),
  log: (message: string) => process.stderr.write(`[LOG] ${message}\n`),
};

/** Base directory for export writes. Absolute paths are used as-is; relative paths resolve from server cwd. */
function resolveOutputBase(outputDir?: string): string {
  if (!outputDir?.trim()) {
    return path.resolve(process.cwd());
  }
  const dir = outputDir.trim();
  return path.isAbsolute(dir) ? path.resolve(dir) : path.resolve(process.cwd(), dir);
}

function resolveExportWritePath(writePath: string, outputDir?: string): string {
  const base = resolveOutputBase(outputDir);
  const targetAbs = path.resolve(base, writePath);
  const relToBase = path.relative(base, targetAbs);
  if (relToBase.startsWith("..") || path.isAbsolute(relToBase)) {
    const scope = outputDir?.trim()
      ? `outputDir (${base})`
      : "server cwd";
    throw new Error(`writePath must stay under ${scope}: ${writePath}`);
  }
  return targetAbs;
}

function writeSvgToPath(
  writePath: string,
  svg: string,
  outputDir?: string
): { absolutePath: string; writePath: string; outputDir: string; bytes: number } {
  const base = resolveOutputBase(outputDir);
  const abs = resolveExportWritePath(writePath, outputDir);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, svg, "utf-8");
  return {
    absolutePath: abs,
    writePath: path.relative(base, abs),
    outputDir: base,
    bytes: Buffer.byteLength(svg, "utf-8"),
  };
}

function writePngToPath(
  writePath: string,
  base64: string,
  outputDir?: string
): { absolutePath: string; writePath: string; outputDir: string; bytes: number } {
  const base = resolveOutputBase(outputDir);
  const abs = resolveExportWritePath(writePath, outputDir);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const buf = Buffer.from(base64, "base64");
  fs.writeFileSync(abs, buf);
  return {
    absolutePath: abs,
    writePath: path.relative(base, abs),
    outputDir: base,
    bytes: buf.length,
  };
}

const exportOutputDirField = z
  .string()
  .optional()
  .describe(
    "Directory to write files into. Absolute path or path relative to the MCP server cwd. When set, writePath is resolved under this directory instead of cwd."
  );

const exportWritePathField = z
  .string()
  .optional()
  .describe(
    "File path (and optional subfolders) under outputDir, or under the MCP server cwd when outputDir is omitted. No path traversal."
  );

function parsePluginSvgPayload(
  result: { svg?: string; imageData?: string },
  nodeId: string
): { ok: true; svg: string } | { ok: false; message: string } {
  if (result.svg && result.svg.trimStart().startsWith("<")) {
    return { ok: true, svg: result.svg };
  }

  if (!result.imageData) {
    return {
      ok: false,
      message: `No SVG payload for node ${nodeId}. Reload the dev plugin from this repo.`,
    };
  }

  const buf = Buffer.from(result.imageData, "base64");
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return {
      ok: false,
      message: `Export for ${nodeId} returned PNG instead of SVG. Reload the dev plugin.`,
    };
  }

  const svg = buf.toString("utf-8").trimStart();
  if (!svg.startsWith("<")) {
    return {
      ok: false,
      message: `Export for ${nodeId} was not valid SVG markup.`,
    };
  }

  return { ok: true, svg };
}

/** Figma API: `2403:34143` or instance paths `I2403:34143;2120:1096`. URLs use hyphens per segment. */
const FIGMA_NODE_ID_FORMAT_HINT =
  "Use Figma API ids (digits and colon, e.g. 2403:34143), paste from a URL (2403-34143), or an instance path (I2403-34143-2120-1096 → I2403:34143;2120:1096).";

const FIGMA_NODE_ID_RE = /^(I)?(\d+:\d+)(;\d+:\d+)*$/;

function normalizeFigmaNodeId(id: string): string {
  let s = id.trim();
  if (!s) {
    throw new Error("nodeId is required");
  }

  const urlMatch = s.match(/(?:[?&]|^)node-id=([^&]+)/i);
  if (urlMatch) {
    s = decodeURIComponent(urlMatch[1]);
  } else {
    try {
      if (/%[0-9A-Fa-f]{2}/.test(s)) {
        s = decodeURIComponent(s);
      }
    } catch {
      // keep s
    }
  }

  s = s.trim();

  if (FIGMA_NODE_ID_RE.test(s)) {
    return s;
  }

  if (s.includes("-")) {
    const instancePrefix = s.startsWith("I");
    const body = instancePrefix ? s.slice(1) : s;
    const segments = body.split("-");
    if (segments.length < 2 || segments.length % 2 !== 0) {
      throw new Error(
        `Invalid node id "${id}": expected pageId-nodeId (2403-34143) or instance path (I2403-34143-2120-1096)`
      );
    }
    const pairs: string[] = [];
    for (let i = 0; i < segments.length; i += 2) {
      if (!/^\d+$/.test(segments[i]) || !/^\d+$/.test(segments[i + 1])) {
        throw new Error(`Invalid node id "${id}": segments must be numeric`);
      }
      pairs.push(`${segments[i]}:${segments[i + 1]}`);
    }
    const normalized = (instancePrefix ? "I" : "") + pairs.join(";");
    if (!FIGMA_NODE_ID_RE.test(normalized)) {
      throw new Error(`Invalid node id "${id}" after normalization: ${normalized}`);
    }
    return normalized;
  }

  throw new Error(
    `Invalid node id "${id}": use pageId:nodeId (e.g. 2403:34143) or URL form 2403-34143`
  );
}

function figmaNodeIdField(description: string) {
  return z
    .string()
    .describe(`${description} ${FIGMA_NODE_ID_FORMAT_HINT}`)
    .transform(normalizeFigmaNodeId);
}

function figmaNodeIdArrayField(description: string) {
  return z
    .array(z.string().transform(normalizeFigmaNodeId))
    .min(1)
    .describe(`${description} ${FIGMA_NODE_ID_FORMAT_HINT}`);
}

let ws: WebSocket | null = null;
const pendingRequests = new Map<
  string,
  {
    resolve: (value: unknown) => void;
    reject: (reason: unknown) => void;
    timeout: ReturnType<typeof setTimeout>;
    lastActivity: number;
  }
>();

let currentChannel: string | null = null;
let currentChannelDescription: string | null = null;

const server = new McpServer({
  name: "figma-mcp",
  version: "2.0.0",
});

const args = process.argv.slice(2);
const serverArg = args.find((arg) => arg.startsWith("--server="));
const serverUrl = serverArg ? serverArg.split("=")[1] : "localhost";
const WS_URL = serverUrl === "localhost" ? `ws://${serverUrl}` : `wss://${serverUrl}`;

const socketPortArg = args.find((a) => a.startsWith("--port="));
const FIGMA_SOCKET_PORT = (() => {
  const n = socketPortArg
    ? Number(socketPortArg.split("=", 2)[1])
    : Number(process.env.PORT || "3055");
  return Number.isFinite(n) && n > 0 ? n : 3055;
})();

function rgbaToHex(color: { r: number; g: number; b: number; a?: number } | string): string {
  if (typeof color === "string" && color.startsWith("#")) {
    return color;
  }
  const c = color as { r: number; g: number; b: number; a?: number };
  const r = Math.round(c.r * 255);
  const g = Math.round(c.g * 255);
  const b = Math.round(c.b * 255);
  const a = Math.round((c.a ?? 1) * 255);
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}${a === 255 ? "" : a.toString(16).padStart(2, "0")}`;
}

function filterFigmaNode(node: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!node || typeof node !== "object") {
    return null;
  }

  const filtered: Record<string, unknown> = { ...node };

  if (Array.isArray(node.children)) {
    filtered.children = node.children
      .map((child) => filterFigmaNode(child as Record<string, unknown>))
      .filter((child): child is Record<string, unknown> => child !== null);
  }

  return filtered;
}

interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface NodeBoxSummary {
  id: string;
  name: string;
  type: string;
  box: BoundingBox;
  edges: { top: number; right: number; bottom: number; left: number };
  center: { x: number; y: number };
}

type GapAxis = "vertical" | "horizontal" | "diagonal" | "overlap";

interface GapMeasurement {
  edgeGapPx: number;
  horizontalGapPx: number;
  verticalGapPx: number;
  axis: GapAxis;
  centerDistancePx: number;
  centerDelta: { x: number; y: number };
  /** When stacked/overlapping on X: signed vertical edge gap (B below A is positive). */
  verticalEdgeFromAToBPx: number | null;
  /** When stacked/overlapping on Y: signed horizontal edge gap (B right of A is positive). */
  horizontalEdgeFromAToBPx: number | null;
}

function extractBoundingBox(node: Record<string, unknown>): BoundingBox | null {
  const raw = node.absoluteBoundingBox as Record<string, unknown> | undefined;
  if (
    !raw ||
    typeof raw.x !== "number" ||
    typeof raw.y !== "number" ||
    typeof raw.width !== "number" ||
    typeof raw.height !== "number"
  ) {
    return null;
  }
  return { x: raw.x, y: raw.y, width: raw.width, height: raw.height };
}

function summarizeNodeBox(node: Record<string, unknown>): NodeBoxSummary {
  const box = extractBoundingBox(node);
  if (!box) {
    throw new Error(`Node "${node.id}" (${node.name}) has no absoluteBoundingBox`);
  }
  return {
    id: String(node.id),
    name: String(node.name ?? ""),
    type: String(node.type ?? ""),
    box,
    edges: {
      top: box.y,
      left: box.x,
      right: box.x + box.width,
      bottom: box.y + box.height,
    },
    center: {
      x: box.x + box.width / 2,
      y: box.y + box.height / 2,
    },
  };
}

function measureGapBetween(boxA: BoundingBox, boxB: BoundingBox): GapMeasurement {
  const aL = boxA.x;
  const aT = boxA.y;
  const aR = boxA.x + boxA.width;
  const aB = boxA.y + boxA.height;
  const bL = boxB.x;
  const bT = boxB.y;
  const bR = boxB.x + boxB.width;
  const bB = boxB.y + boxB.height;

  const horizontalGapPx = Math.max(0, Math.max(aL - bR, bL - aR));
  const verticalGapPx = Math.max(0, Math.max(aT - bB, bT - aB));

  let axis: GapAxis;
  let edgeGapPx: number;
  if (horizontalGapPx === 0 && verticalGapPx === 0) {
    axis = "overlap";
    edgeGapPx = 0;
  } else if (horizontalGapPx === 0) {
    axis = "vertical";
    edgeGapPx = verticalGapPx;
  } else if (verticalGapPx === 0) {
    axis = "horizontal";
    edgeGapPx = horizontalGapPx;
  } else {
    axis = "diagonal";
    edgeGapPx = Math.hypot(horizontalGapPx, verticalGapPx);
  }

  const centerA = { x: boxA.x + boxA.width / 2, y: boxA.y + boxA.height / 2 };
  const centerB = { x: boxB.x + boxB.width / 2, y: boxB.y + boxB.height / 2 };
  const centerDelta = { x: centerB.x - centerA.x, y: centerB.y - centerA.y };

  const verticalEdgeFromAToBPx =
    horizontalGapPx === 0 ? Math.round((bT - aB) * 100) / 100 : null;
  const horizontalEdgeFromAToBPx =
    verticalGapPx === 0 ? Math.round((bL - aR) * 100) / 100 : null;

  return {
    edgeGapPx: Math.round(edgeGapPx * 100) / 100,
    horizontalGapPx: Math.round(horizontalGapPx * 100) / 100,
    verticalGapPx: Math.round(verticalGapPx * 100) / 100,
    axis,
    centerDistancePx: Math.round(Math.hypot(centerDelta.x, centerDelta.y) * 100) / 100,
    centerDelta: {
      x: Math.round(centerDelta.x * 100) / 100,
      y: Math.round(centerDelta.y * 100) / 100,
    },
    verticalEdgeFromAToBPx,
    horizontalEdgeFromAToBPx,
  };
}

type FigmaCommand =
  | "get_node_info"
  | "get_nodes_info"
  | "get_asset"
  | "export_node_as_svg"
  | "export_node_as_image"
  | "join";

type CommandParams = {
  get_node_info: { nodeId: string };
  get_nodes_info: { nodeIds: string[] };
  get_asset: { nodeIds: string[] };
  export_node_as_svg: { nodeId: string };
  export_node_as_image: { nodeId: string; scale?: number };
  join: { channel: string; channel_description?: string };
};

function connectToFigma(port: number = FIGMA_SOCKET_PORT) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    logger.info("Already connected to Figma");
    return;
  }

  const wsUrl = serverUrl === "localhost" ? `${WS_URL}:${port}` : WS_URL;
  logger.info(`Connecting to Figma socket server at ${wsUrl}...`);
  ws = new WebSocket(wsUrl);

  ws.on("open", () => {
    logger.info("Connected to Figma socket server");
    const savedChannel = currentChannel;
    const savedDescription = currentChannelDescription;
    if (savedChannel) {
      void (async () => {
        try {
          await joinChannel(savedChannel, savedDescription || undefined);
          logger.info(`Re-joined relay channel "${savedChannel}" after reconnect`);
        } catch (err) {
          logger.error(
            `Failed to re-join channel after reconnect: ${err instanceof Error ? err.message : String(err)}`
          );
          currentChannel = null;
          currentChannelDescription = null;
        }
      })();
    }
  });

  ws.on("message", (data: WebSocket.RawData) => {
    try {
      interface ProgressMessage {
        message: FigmaResponse | Record<string, unknown>;
        type?: string;
        id?: string;
        [key: string]: unknown;
      }

      const json = JSON.parse(String(data)) as ProgressMessage;

      if (json.type === "channel_list" && typeof json.id === "string" && pendingRequests.has(json.id)) {
        const request = pendingRequests.get(json.id)!;
        clearTimeout(request.timeout);
        pendingRequests.delete(json.id);
        request.resolve(Array.isArray(json.channels) ? json.channels : []);
        return;
      }

      if (json.type === "progress_update") {
        const progressData = (json.message as { data?: CommandProgressUpdate }).data;
        const requestId = json.id || "";

        if (requestId && pendingRequests.has(requestId) && progressData) {
          const request = pendingRequests.get(requestId)!;
          request.lastActivity = Date.now();
          clearTimeout(request.timeout);
          request.timeout = setTimeout(() => {
            if (pendingRequests.has(requestId)) {
              logger.error(`Request ${requestId} timed out after extended inactivity`);
              pendingRequests.delete(requestId);
              request.reject(new Error("Request to Figma timed out"));
            }
          }, 60000);
          logger.info(
            `Progress for ${progressData.commandType}: ${progressData.progress}% - ${progressData.message}`
          );
        }
        return;
      }

      const myResponse = json.message as FigmaResponse;
      logger.debug(`Received message: ${JSON.stringify(myResponse)}`);

      if (myResponse?.id && pendingRequests.has(myResponse.id)) {
        const request = pendingRequests.get(myResponse.id)!;
        clearTimeout(request.timeout);

        if (myResponse.error) {
          logger.error(`Error from Figma: ${myResponse.error}`);
          request.reject(new Error(myResponse.error));
        } else if (myResponse.result !== undefined) {
          request.resolve(myResponse.result);
        }

        pendingRequests.delete(myResponse.id);
      } else if (myResponse) {
        logger.info(`Received broadcast message: ${JSON.stringify(myResponse)}`);
      }
    } catch (error) {
      logger.error(
        `Error parsing message: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  });

  ws.on("error", (error) => {
    logger.error(`Socket error: ${error}`);
  });

  ws.on("close", () => {
    logger.info("Disconnected from Figma socket server");
    ws = null;

    for (const [id, request] of pendingRequests.entries()) {
      clearTimeout(request.timeout);
      request.reject(new Error("Connection closed"));
      pendingRequests.delete(id);
    }

    logger.info("Attempting to reconnect in 2 seconds...");
    setTimeout(() => connectToFigma(port), 2000);
  });
}

function listActiveRelayChannels(timeoutMs: number = 10000): Promise<RelayChannel[]> {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      connectToFigma();
      reject(new Error("Not connected to Figma relay. Attempting to connect..."));
      return;
    }
    const id = uuidv4();
    const timeout = setTimeout(() => {
      if (pendingRequests.has(id)) {
        pendingRequests.delete(id);
        reject(new Error("Request to list channels timed out"));
      }
    }, timeoutMs);
    pendingRequests.set(id, {
      resolve: (value: unknown) => resolve(value as RelayChannel[]),
      reject,
      timeout,
      lastActivity: Date.now(),
    });
    ws.send(JSON.stringify({ type: "list_channels", id }));
    logger.info("Sent list_channels to relay");
  });
}

function findChannelByDescription(
  channels: RelayChannel[],
  description: string
): RelayChannel | null {
  const needle = description.trim().toLowerCase();
  if (!needle) return null;

  const exact = channels.filter(
    (c) => c.description?.trim().toLowerCase() === needle
  );
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) {
    throw new Error(
      `Multiple channels match description "${description}": ${exact.map((c) => c.name).join(", ")}`
    );
  }

  const partial = channels.filter((c) =>
    c.description?.trim().toLowerCase().includes(needle)
  );
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) {
    throw new Error(
      `Multiple channels partially match "${description}": ${partial.map((c) => `${c.name} (${c.description})`).join("; ")}`
    );
  }

  return null;
}

async function joinChannel(channelName: string, channelDescription?: string): Promise<void> {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    throw new Error("Not connected to Figma");
  }

  await sendCommandToFigma("join", {
    channel: channelName,
    channel_description: channelDescription,
  });
  currentChannel = channelName;
  currentChannelDescription = channelDescription?.trim() || null;
  logger.info(`Joined channel: ${channelName}`);
}

function sendCommandToFigma<T extends FigmaCommand>(
  command: T,
  params: CommandParams[T] = {} as CommandParams[T],
  timeoutMs: number = 30000
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      connectToFigma();
      reject(new Error("Not connected to Figma. Attempting to connect..."));
      return;
    }

    const requiresChannel = command !== "join";
    if (requiresChannel && !currentChannel) {
      reject(new Error("Must join a channel before sending commands"));
      return;
    }

    const id = uuidv4();
    const request = {
      id,
      type: command === "join" ? "join" : "message",
      ...(command === "join"
        ? { channel: (params as CommandParams["join"]).channel }
        : { channel: currentChannel }),
      message: {
        id,
        command,
        params: {
          ...(params as Record<string, unknown>),
          commandId: id,
        },
      },
    };

    const timeout = setTimeout(() => {
      if (pendingRequests.has(id)) {
        pendingRequests.delete(id);
        logger.error(`Request ${id} to Figma timed out after ${timeoutMs / 1000} seconds`);
        reject(new Error("Request to Figma timed out"));
      }
    }, timeoutMs);

    pendingRequests.set(id, {
      resolve,
      reject,
      timeout,
      lastActivity: Date.now(),
    });

    logger.info(`Sending command to Figma: ${command}`);
    logger.debug(`Request details: ${JSON.stringify(request)}`);
    ws.send(JSON.stringify(request));
  });
}

function generateRandomChannelName(length: number = 8): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

server.tool(
  "list_channels",
  "List all WebSocket relay channels that currently have at least one connected client. Each entry includes name, clientCount, and optional description (set when a client joins with channel_description). Use list_channels then join_channel with a matching description to connect automatically.",
  {},
  async () => {
    try {
      const channels = await listActiveRelayChannels();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ channels, count: channels.length }, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error listing channels: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

server.tool(
  "join_channel",
  "Join a WebSocket relay channel to communicate with the Figma plugin. Omit channel and pass channel_description to auto-join the single matching channel from list_channels.",
  {
    channel: z.string().describe("The channel name to join").optional(),
    channel_description: z
      .string()
      .describe(
        "Human-readable label for this session, or search term to auto-join an existing channel when channel is omitted"
      )
      .optional(),
  },
  async ({ channel, channel_description }) => {
    try {
      const normalizedChannel = typeof channel === "string" ? channel.trim() : "";
      const normalizedDescription =
        typeof channel_description === "string" ? channel_description.trim() : "";

      let resolvedChannel = normalizedChannel;
      let matchedByDescription = false;

      if (!resolvedChannel && normalizedDescription) {
        const channels = await listActiveRelayChannels();
        const match = findChannelByDescription(channels, normalizedDescription);
        if (!match) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  error: `No channel found matching description "${normalizedDescription}"`,
                  availableChannels: channels,
                }),
              },
            ],
          };
        }
        resolvedChannel = match.name;
        matchedByDescription = true;
      }

      if (!resolvedChannel) {
        resolvedChannel = generateRandomChannelName();
      }

      await joinChannel(
        resolvedChannel,
        matchedByDescription ? undefined : normalizedDescription || undefined
      );

      const descriptionSuffix = normalizedDescription
        ? ` (description: ${normalizedDescription})`
        : "";
      const autoSuffix = matchedByDescription ? " [auto-joined by description]" : "";

      return {
        content: [
          {
            type: "text",
            text: `Successfully joined channel: ${resolvedChannel}${descriptionSuffix}${autoSuffix}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error joining channel: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

server.tool(
  "get_node_info",
  "Get detailed information about a specific node in Figma. Omits child nodes with absoluteRenderBounds: null (unpainted); do not create HTML elements for those nodes.",
  {
    nodeId: figmaNodeIdField("The ID of the node to get information about"),
  },
  async ({ nodeId }) => {
    try {
      const result = await sendCommandToFigma("get_node_info", { nodeId });
      const filtered = filterFigmaNode(result as Record<string, unknown>);
      if (!filtered) {
        throw new Error(`Node not found: ${nodeId}`);
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ nodeId, ...filtered }),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error getting node info: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

server.tool(
  "get_nodes_info",
  "Get detailed information about multiple nodes in Figma. Omits nodes with absoluteRenderBounds: null (unpainted).",
  {
    nodeIds: figmaNodeIdArrayField("Array of node IDs to get information about"),
  },
  async ({ nodeIds }) => {
    try {
      const raw = await sendCommandToFigma("get_nodes_info", { nodeIds });
      const entries = raw as { nodeId: string; document: Record<string, unknown> | null }[];
      if (!Array.isArray(entries)) {
        throw new Error("Unexpected response from Figma when fetching nodes");
      }

      const results = entries.map((e) => ({
        nodeId: e.nodeId,
        info: filterFigmaNode(e.document),
      }));

      const missing = nodeIds.filter(
        (id) => !results.some((r) => r.nodeId === id && r.info !== null)
      );
      if (missing.length > 0) {
        throw new Error(`Node(s) not found: ${missing.join(", ")}`);
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(results),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error getting nodes info: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

server.tool(
  "get_asset",
  "Predict whether each Figma node is an exportable icon/asset. Returns filtered node objects with assetPrediction (0–100), isAsset (score >= 50), and exportTarget (deduplicated: one export per nested asset chain — prefers the nearest isAsset INSTANCE on the path from root to the deepest asset, else parent of a vector primitive, else the deepest asset). Scoring treats visible IMAGE fills (and gifRef animated GIFs) as raster assets. Also returns exportNodeIds at the response root.",
  {
    nodeIds: figmaNodeIdArrayField("Node IDs to classify as assets"),
  },
  async ({ nodeIds }) => {
    try {
      const raw = await sendCommandToFigma("get_asset", { nodeIds });
      const entries = raw as {
        nodeId: string;
        document: Record<string, unknown> | null;
        error?: string;
      }[];

      if (!Array.isArray(entries)) {
        throw new Error("Unexpected response from Figma when fetching assets");
      }

      const missing = nodeIds.filter(
        (id) => !entries.some((e) => e.nodeId === id)
      );
      if (missing.length > 0) {
        throw new Error(`Node(s) not found: ${missing.join(", ")}`);
      }

      const notFound = entries.filter((e) => e.error || e.document === null);
      if (notFound.length > 0) {
        const ids = notFound.map((e) => e.nodeId).join(", ");
        throw new Error(`Node(s) not found: ${ids}`);
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(entries),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error getting asset predictions: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

server.tool(
  "export_node_as_svg",
  "Export a Figma node as SVG via exportAsync (SVG_STRING). Returns UTF-8 markup; optional writePath writes a .svg file. Use outputDir for a custom absolute or relative destination (e.g. project assets folder).",
  {
    nodeId: figmaNodeIdField("The ID of the node to export as SVG"),
    writePath: exportWritePathField,
    outputDir: exportOutputDirField,
  },
  async ({ nodeId, writePath, outputDir }) => {
    try {
      const raw = await sendCommandToFigma("export_node_as_svg", { nodeId });
      const result = raw as { svg?: string; imageData?: string; mimeType?: string };
      const parsed = parsePluginSvgPayload(result, nodeId);

      if (parsed.ok === false) {
        return {
          content: [{ type: "text", text: parsed.message }],
        };
      }

      const content: Array<
        | { type: "text"; text: string }
        | { type: "image"; data: string; mimeType: string }
      > = [];

      if (writePath) {
        const w = writeSvgToPath(writePath, parsed.svg, outputDir);
        content.push({
          type: "text",
          text: JSON.stringify({
            nodeId,
            writePath: w.writePath,
            absolutePath: w.absolutePath,
            outputDir: w.outputDir,
            bytes: w.bytes,
            message: `Wrote ${w.absolutePath} (${w.bytes} bytes, UTF-8).`,
          }),
        });
      } else {
        content.push({
          type: "text",
          text: JSON.stringify({
            nodeId,
            bytes: Buffer.byteLength(parsed.svg, "utf-8"),
            message: `SVG export for node ${nodeId}.`,
          }),
        });
      }

      content.push({
        type: "text",
        text: parsed.svg,
      });

      return { content };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error exporting node as SVG: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

server.tool(
  "export_node_as_image",
  "Export a Figma node as PNG via exportAsync. Returns base64 image data; optional writePath writes a .png file. Use outputDir for a custom absolute or relative destination (e.g. project assets folder).",
  {
    nodeId: figmaNodeIdField("The ID of the node to export as PNG"),
    scale: z
      .number()
      .min(0.01)
      .max(8)
      .optional()
      .default(1)
      .describe("Export scale factor (2–4 typical for retina assets)."),
    writePath: exportWritePathField,
    outputDir: exportOutputDirField,
  },
  async ({ nodeId, scale, writePath, outputDir }) => {
    try {
      const raw = await sendCommandToFigma("export_node_as_image", { nodeId, scale });
      const result = raw as {
        imageData?: string;
        mimeType?: string;
        format?: string;
        scale?: number;
      };

      if (!result.imageData) {
        return {
          content: [
            {
              type: "text",
              text: `No PNG payload for node ${nodeId}. Reload the dev plugin from this repo.`,
            },
          ],
        };
      }

      const buf = Buffer.from(result.imageData, "base64");
      if (buf.length < 4 || buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) {
        return {
          content: [
            {
              type: "text",
              text: `Export for ${nodeId} was not valid PNG data.`,
            },
          ],
        };
      }

      const content: Array<
        | { type: "text"; text: string }
        | { type: "image"; data: string; mimeType: string }
      > = [];

      if (writePath) {
        const w = writePngToPath(writePath, result.imageData, outputDir);
        content.push({
          type: "text",
          text: JSON.stringify({
            nodeId,
            format: "PNG",
            scale: result.scale ?? scale,
            writePath: w.writePath,
            absolutePath: w.absolutePath,
            outputDir: w.outputDir,
            bytes: w.bytes,
            message: `Wrote ${w.absolutePath} (${w.bytes} bytes).`,
          }),
        });
      } else {
        content.push({
          type: "text",
          text: JSON.stringify({
            nodeId,
            format: "PNG",
            scale: result.scale ?? scale,
            bytes: buf.length,
            message: `PNG export for node ${nodeId}.`,
          }),
        });
        content.push({
          type: "image",
          data: result.imageData,
          mimeType: result.mimeType ?? "image/png",
        });
      }

      return { content };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error exporting node as PNG: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

server.tool(
  "measure_gap_between",
  "Measure the edge-to-edge gap between two Figma nodes using their absoluteBoundingBox (works across any depth in the layer tree). Returns minimum edge gap, axis-aligned separation, center distance, and directional offsets from node A to node B.",
  {
    nodeIdA: figmaNodeIdField("First node (reference)"),
    nodeIdB: figmaNodeIdField("Second node"),
  },
  async ({ nodeIdA, nodeIdB }) => {
    try {
      if (nodeIdA === nodeIdB) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ error: "nodeIdA and nodeIdB must be different" }),
            },
          ],
        };
      }

      const raw = await sendCommandToFigma("get_nodes_info", {
        nodeIds: [nodeIdA, nodeIdB],
      });

      const entries = raw as { nodeId: string; document: Record<string, unknown> | null }[];
      if (!Array.isArray(entries) || entries.length < 2) {
        throw new Error("Unexpected response from Figma when fetching nodes");
      }

      const byId = new Map(entries.map((e) => [e.nodeId, e.document]));
      const docA = byId.get(nodeIdA);
      const docB = byId.get(nodeIdB);

      if (!docA) {
        throw new Error(`Node not found: ${nodeIdA}`);
      }
      if (!docB) {
        throw new Error(`Node not found: ${nodeIdB}`);
      }

      const nodeA = summarizeNodeBox(docA);
      const nodeB = summarizeNodeBox(docB);
      const gap = measureGapBetween(nodeA.box, nodeB.box);

      const payload = {
        nodeA: {
          id: nodeA.id,
          name: nodeA.name,
          type: nodeA.type,
          absoluteBoundingBox: nodeA.box,
          edges: nodeA.edges,
          center: nodeA.center,
        },
        nodeB: {
          id: nodeB.id,
          name: nodeB.name,
          type: nodeB.type,
          absoluteBoundingBox: nodeB.box,
          edges: nodeB.edges,
          center: nodeB.center,
        },
        gap,
        summary:
          gap.axis === "overlap"
            ? "Nodes overlap (0px edge gap)."
            : gap.axis === "vertical" && gap.verticalEdgeFromAToBPx !== null
              ? `${gap.edgeGapPx}px vertical edge gap (${nodeB.name} is ${gap.verticalEdgeFromAToBPx >= 0 ? "below" : "above"} ${nodeA.name}).`
              : gap.axis === "horizontal" && gap.horizontalEdgeFromAToBPx !== null
                ? `${gap.edgeGapPx}px horizontal edge gap (${nodeB.name} is ${gap.horizontalEdgeFromAToBPx >= 0 ? "right of" : "left of"} ${nodeA.name}).`
                : `${gap.edgeGapPx}px minimum edge gap (${gap.axis}).`,
      };

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(payload, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error measuring gap: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

async function main() {
  try {
    connectToFigma();
  } catch (error) {
    logger.warn(
      `Could not connect to Figma initially: ${error instanceof Error ? error.message : String(error)}`
    );
    logger.warn("Will try to connect when the first command is sent");
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info(
    "figma-mcp running on stdio (tools: list_channels, join_channel, get_node_info, get_nodes_info, get_asset, export_node_as_svg, export_node_as_image, measure_gap_between)"
  );
}

main().catch((error) => {
  logger.error(
    `Error starting FigmaMCP server: ${error instanceof Error ? error.message : String(error)}`
  );
  process.exit(1);
});
