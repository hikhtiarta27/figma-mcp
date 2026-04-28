#!/usr/bin/env node
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// src/talk_to_figma_mcp/server.ts
var import_node_fs = __toESM(require("fs"), 1);
var import_node_path = __toESM(require("path"), 1);
var import_mcp = require("@modelcontextprotocol/sdk/server/mcp.js");
var import_stdio = require("@modelcontextprotocol/sdk/server/stdio.js");
var import_zod = require("zod");
var import_ws = __toESM(require("ws"), 1);
var import_uuid = require("uuid");
function decodeBase64ExportAsSvg(imageDataBase64) {
  const buf = Buffer.from(imageDataBase64, "base64");
  if (buf.length >= 4 && buf[0] === 137 && buf[1] === 80 && buf[2] === 78 && buf[3] === 71) {
    return { ok: false, kind: "png" };
  }
  if (buf.length >= 3 && buf[0] === 255 && buf[1] === 216 && buf[2] === 255) {
    return { ok: false, kind: "jpeg" };
  }
  const asciiHead = buf.subarray(0, Math.min(8, buf.length)).toString("ascii");
  if (asciiHead.startsWith("%PDF")) {
    return { ok: false, kind: "pdf" };
  }
  const svg = buf.toString("utf-8").trimStart();
  if (!svg.startsWith("<")) {
    return { ok: false, kind: "unknown" };
  }
  return { ok: true, svg };
}
function resolveWritePathUnderCwd(rel) {
  const root = import_node_path.default.resolve(process.cwd());
  const targetAbs = import_node_path.default.resolve(root, rel);
  const relToRoot = import_node_path.default.relative(root, targetAbs);
  if (relToRoot.startsWith("..") || import_node_path.default.isAbsolute(relToRoot)) {
    throw new Error(`writePath must stay under server cwd: ${rel}`);
  }
  return targetAbs;
}
function parsePluginSvgExport(imageDataBase64, nodeId) {
  const decoded = decodeBase64ExportAsSvg(imageDataBase64);
  if (decoded.ok === false) {
    const kind = decoded.kind;
    const hint = kind === "png" ? "The Figma plugin returned PNG (SVG was requested). Reload the dev plugin from this repo (src/cursor_mcp_plugin) so export_node_as_image uses format SVG in exportAsync." : "The export payload was not valid SVG text.";
    return {
      ok: false,
      kind,
      message: `${hint}

nodeId: ${nodeId}
detected: ${kind}`
    };
  }
  return { ok: true, svg: decoded.svg };
}
function writeSvgUtf8UnderCwd(relPath, svg) {
  const abs = resolveWritePathUnderCwd(relPath);
  import_node_fs.default.mkdirSync(import_node_path.default.dirname(abs), { recursive: true });
  import_node_fs.default.writeFileSync(abs, svg, "utf-8");
  return {
    rel: import_node_path.default.relative(process.cwd(), abs),
    bytes: Buffer.byteLength(svg, "utf-8")
  };
}
function mcpContentForSvgExport(args2) {
  const content = [];
  if (args2.writePath) {
    const w = writeSvgUtf8UnderCwd(args2.writePath, args2.svg);
    content.push({
      type: "text",
      text: `Wrote ${w.rel} (${w.bytes} bytes, UTF-8).`
    });
  }
  const intro = args2.fromImageTool ? args2.writePath ? `SVG export for node ${args2.nodeId} (file written; XML below for clipboard, a .svg file, or inline HTML).

` : `SVG export for node ${args2.nodeId}. Use the XML below in a .svg file, clipboard, or inline in HTML.

` : args2.writePath ? `SVG export for node ${args2.nodeId} (file written; full markup below).

` : `SVG export for node ${args2.nodeId}.

`;
  content.push({ type: "text", text: intro + args2.svg });
  content.push({
    type: "image",
    data: args2.imageDataBase64,
    mimeType: args2.mimeType || "image/svg+xml"
  });
  return { content };
}
var logger = {
  info: (message) => process.stderr.write(`[INFO] ${message}
`),
  debug: (message) => process.stderr.write(`[DEBUG] ${message}
`),
  warn: (message) => process.stderr.write(`[WARN] ${message}
`),
  error: (message) => process.stderr.write(`[ERROR] ${message}
`),
  log: (message) => process.stderr.write(`[LOG] ${message}
`)
};
var ws = null;
var pendingRequests = /* @__PURE__ */ new Map();
var currentChannel = null;
var currentChannelDescription = null;
var server = new import_mcp.McpServer({
  name: "TalkToFigmaMCP",
  version: "1.0.0"
});
var args = process.argv.slice(2);
var serverArg = args.find((arg) => arg.startsWith("--server="));
var serverUrl = serverArg ? serverArg.split("=")[1] : "localhost";
var WS_URL = serverUrl === "localhost" ? `ws://${serverUrl}` : `wss://${serverUrl}`;
var socketPortArg = args.find((a) => a.startsWith("--port="));
var FIGMA_SOCKET_PORT = (() => {
  const n = socketPortArg ? Number(socketPortArg.split("=", 2)[1]) : Number(process.env.PORT || "3055");
  return Number.isFinite(n) && n > 0 ? n : 3055;
})();
function cliArgValue(argv, prefix) {
  const hit = argv.find((a) => a.startsWith(prefix));
  return hit === void 0 ? void 0 : hit.slice(prefix.length);
}
function tryParseExportPngCli(argv) {
  if (!argv.includes("--export-png")) {
    return null;
  }
  const channel = cliArgValue(argv, "--channel=") ?? "";
  const nodeId = cliArgValue(argv, "--node=") ?? "";
  const outRel = cliArgValue(argv, "--out=") ?? "";
  const scaleRaw = cliArgValue(argv, "--scale=");
  const scale = scaleRaw !== void 0 && scaleRaw !== "" ? Number(scaleRaw) : 4;
  if (!channel || !nodeId || !outRel) {
    process.stderr.write(
      "Usage: cursor-talk-to-figma-mcp --export-png --channel=CH --node=NODE_ID --out=relative/path.png [--scale=4] [--port=3055]\nRequires WebSocket relay (bun socket) and the Figma plugin on the same channel.\n"
    );
    process.exit(1);
  }
  if (!Number.isFinite(scale) || scale <= 0) {
    process.stderr.write("Invalid --scale (expected a positive number).\n");
    process.exit(1);
  }
  return { channel, nodeId, outRel, scale };
}
var EXPORT_PNG_CLI = tryParseExportPngCli(args);
var CLI_EXPORT_PNG_MODE = EXPORT_PNG_CLI !== null;
function parseClientConnectionMode(argv) {
  const modeArg = argv.find((a) => a.startsWith("--mode="));
  const fromArg = modeArg?.split("=", 2)[1]?.trim().toLowerCase();
  const fromEnv = process.env.MCP_MODE?.trim().toLowerCase();
  const raw = fromArg || fromEnv || "full";
  if (raw === "read-only" || raw === "readonly") return "read-only";
  if (raw === "full") return "full";
  logger.warn(
    `Unknown connection mode "${raw}"; expected full or read-only. Defaulting to full.`
  );
  return "full";
}
var CLIENT_CONNECTION_MODE = parseClientConnectionMode(args);
var READ_ONLY_TOOL_NAMES = /* @__PURE__ */ new Set([
  "join_channel",
  "get_active_channels",
  "get_document_info",
  "get_selection",
  "read_my_design",
  "get_node_info",
  "get_nodes_info",
  "get_annotations",
  "scan_nodes_by_types",
  "scan_text_nodes",
  "get_styles",
  "get_local_components",
  "get_instance_overrides",
  "export_node_as_image",
  "export_node_as_svg",
  "copy_node_as_svg",
  "set_focus",
  "set_selections"
]);
function figmaTool(...toolArgs) {
  const name = toolArgs[0];
  if (CLIENT_CONNECTION_MODE === "read-only" && !READ_ONLY_TOOL_NAMES.has(name)) {
    return;
  }
  server.tool(...toolArgs);
}
function figmaPrompt(...promptArgs) {
  if (CLIENT_CONNECTION_MODE === "read-only") {
    return;
  }
  server.prompt(...promptArgs);
}
figmaTool(
  "get_document_info",
  "Get detailed information about the current Figma document",
  {},
  async () => {
    try {
      const result = await sendCommandToFigma("get_document_info");
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result)
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error getting document info: ${error instanceof Error ? error.message : String(error)}`
          }
        ]
      };
    }
  }
);
figmaTool(
  "get_selection",
  "Get information about the current selection in Figma",
  {},
  async () => {
    try {
      const result = await sendCommandToFigma("get_selection");
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result)
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error getting selection: ${error instanceof Error ? error.message : String(error)}`
          }
        ]
      };
    }
  }
);
figmaTool(
  "read_my_design",
  "Get detailed information about the current selection in Figma, including all node details",
  {},
  async () => {
    try {
      const result = await sendCommandToFigma("read_my_design", {});
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result)
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error getting node info: ${error instanceof Error ? error.message : String(error)}`
          }
        ]
      };
    }
  }
);
figmaTool(
  "get_node_info",
  "Get detailed information about a specific node in Figma",
  {
    nodeId: import_zod.z.string().describe("The ID of the node to get information about")
  },
  async ({ nodeId }) => {
    try {
      const result = await sendCommandToFigma("get_node_info", { nodeId });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(filterFigmaNode(result))
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error getting node info: ${error instanceof Error ? error.message : String(error)}`
          }
        ]
      };
    }
  }
);
function rgbaToHex(color) {
  if (color.startsWith("#")) {
    return color;
  }
  const r = Math.round(color.r * 255);
  const g = Math.round(color.g * 255);
  const b = Math.round(color.b * 255);
  const a = Math.round(color.a * 255);
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}${a === 255 ? "" : a.toString(16).padStart(2, "0")}`;
}
function filterFigmaNode(node) {
  if (node.type === "VECTOR") {
    return null;
  }
  const filtered = {
    id: node.id,
    name: node.name,
    type: node.type
  };
  if (node.fills && node.fills.length > 0) {
    filtered.fills = node.fills.map((fill) => {
      const processedFill = { ...fill };
      delete processedFill.boundVariables;
      delete processedFill.imageRef;
      if (processedFill.gradientStops) {
        processedFill.gradientStops = processedFill.gradientStops.map((stop) => {
          const processedStop = { ...stop };
          if (processedStop.color) {
            processedStop.color = rgbaToHex(processedStop.color);
          }
          delete processedStop.boundVariables;
          return processedStop;
        });
      }
      if (processedFill.color) {
        processedFill.color = rgbaToHex(processedFill.color);
      }
      return processedFill;
    });
  }
  if (node.strokes && node.strokes.length > 0) {
    filtered.strokes = node.strokes.map((stroke) => {
      const processedStroke = { ...stroke };
      delete processedStroke.boundVariables;
      if (processedStroke.color) {
        processedStroke.color = rgbaToHex(processedStroke.color);
      }
      return processedStroke;
    });
  }
  if (node.cornerRadius !== void 0) {
    filtered.cornerRadius = node.cornerRadius;
  }
  if (node.absoluteBoundingBox) {
    filtered.absoluteBoundingBox = node.absoluteBoundingBox;
  }
  if (node.characters) {
    filtered.characters = node.characters;
  }
  if (node.style) {
    filtered.style = {
      fontFamily: node.style.fontFamily,
      fontStyle: node.style.fontStyle,
      fontWeight: node.style.fontWeight,
      fontSize: node.style.fontSize,
      textAlignHorizontal: node.style.textAlignHorizontal,
      letterSpacing: node.style.letterSpacing,
      lineHeightPx: node.style.lineHeightPx
    };
  }
  if (node.children) {
    filtered.children = node.children.map((child) => filterFigmaNode(child)).filter((child) => child !== null);
  }
  return filtered;
}
figmaTool(
  "get_nodes_info",
  "Get detailed information about multiple nodes in Figma",
  {
    nodeIds: import_zod.z.array(import_zod.z.string()).describe("Array of node IDs to get information about")
  },
  async ({ nodeIds }) => {
    try {
      const results = await Promise.all(
        nodeIds.map(async (nodeId) => {
          const result = await sendCommandToFigma("get_node_info", { nodeId });
          return { nodeId, info: result };
        })
      );
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(results.map((result) => filterFigmaNode(result.info)))
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error getting nodes info: ${error instanceof Error ? error.message : String(error)}`
          }
        ]
      };
    }
  }
);
figmaTool(
  "create_rectangle",
  "Create a new rectangle in Figma",
  {
    x: import_zod.z.number().describe("X position"),
    y: import_zod.z.number().describe("Y position"),
    width: import_zod.z.number().describe("Width of the rectangle"),
    height: import_zod.z.number().describe("Height of the rectangle"),
    name: import_zod.z.string().optional().describe("Optional name for the rectangle"),
    parentId: import_zod.z.string().optional().describe("Optional parent node ID to append the rectangle to")
  },
  async ({ x, y, width, height, name, parentId }) => {
    try {
      const result = await sendCommandToFigma("create_rectangle", {
        x,
        y,
        width,
        height,
        name: name || "Rectangle",
        parentId
      });
      return {
        content: [
          {
            type: "text",
            text: `Created rectangle "${JSON.stringify(result)}"`
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error creating rectangle: ${error instanceof Error ? error.message : String(error)}`
          }
        ]
      };
    }
  }
);
figmaTool(
  "create_frame",
  "Create a new frame in Figma",
  {
    x: import_zod.z.number().describe("X position"),
    y: import_zod.z.number().describe("Y position"),
    width: import_zod.z.number().describe("Width of the frame"),
    height: import_zod.z.number().describe("Height of the frame"),
    name: import_zod.z.string().optional().describe("Optional name for the frame"),
    parentId: import_zod.z.string().optional().describe("Optional parent node ID to append the frame to"),
    fillColor: import_zod.z.object({
      r: import_zod.z.number().min(0).max(1).describe("Red component (0-1)"),
      g: import_zod.z.number().min(0).max(1).describe("Green component (0-1)"),
      b: import_zod.z.number().min(0).max(1).describe("Blue component (0-1)"),
      a: import_zod.z.number().min(0).max(1).optional().describe("Alpha component (0-1)")
    }).optional().describe("Fill color in RGBA format"),
    strokeColor: import_zod.z.object({
      r: import_zod.z.number().min(0).max(1).describe("Red component (0-1)"),
      g: import_zod.z.number().min(0).max(1).describe("Green component (0-1)"),
      b: import_zod.z.number().min(0).max(1).describe("Blue component (0-1)"),
      a: import_zod.z.number().min(0).max(1).optional().describe("Alpha component (0-1)")
    }).optional().describe("Stroke color in RGBA format"),
    strokeWeight: import_zod.z.number().positive().optional().describe("Stroke weight"),
    layoutMode: import_zod.z.enum(["NONE", "HORIZONTAL", "VERTICAL"]).optional().describe("Auto-layout mode for the frame"),
    layoutWrap: import_zod.z.enum(["NO_WRAP", "WRAP"]).optional().describe("Whether the auto-layout frame wraps its children"),
    paddingTop: import_zod.z.number().optional().describe("Top padding for auto-layout frame"),
    paddingRight: import_zod.z.number().optional().describe("Right padding for auto-layout frame"),
    paddingBottom: import_zod.z.number().optional().describe("Bottom padding for auto-layout frame"),
    paddingLeft: import_zod.z.number().optional().describe("Left padding for auto-layout frame"),
    primaryAxisAlignItems: import_zod.z.enum(["MIN", "MAX", "CENTER", "SPACE_BETWEEN"]).optional().describe("Primary axis alignment for auto-layout frame. Note: When set to SPACE_BETWEEN, itemSpacing will be ignored as children will be evenly spaced."),
    counterAxisAlignItems: import_zod.z.enum(["MIN", "MAX", "CENTER", "BASELINE"]).optional().describe("Counter axis alignment for auto-layout frame"),
    layoutSizingHorizontal: import_zod.z.enum(["FIXED", "HUG", "FILL"]).optional().describe("Horizontal sizing mode for auto-layout frame"),
    layoutSizingVertical: import_zod.z.enum(["FIXED", "HUG", "FILL"]).optional().describe("Vertical sizing mode for auto-layout frame"),
    itemSpacing: import_zod.z.number().optional().describe("Distance between children in auto-layout frame. Note: This value will be ignored if primaryAxisAlignItems is set to SPACE_BETWEEN.")
  },
  async ({
    x,
    y,
    width,
    height,
    name,
    parentId,
    fillColor,
    strokeColor,
    strokeWeight,
    layoutMode,
    layoutWrap,
    paddingTop,
    paddingRight,
    paddingBottom,
    paddingLeft,
    primaryAxisAlignItems,
    counterAxisAlignItems,
    layoutSizingHorizontal,
    layoutSizingVertical,
    itemSpacing
  }) => {
    try {
      const result = await sendCommandToFigma("create_frame", {
        x,
        y,
        width,
        height,
        name: name || "Frame",
        parentId,
        fillColor: fillColor || { r: 1, g: 1, b: 1, a: 1 },
        strokeColor,
        strokeWeight,
        layoutMode,
        layoutWrap,
        paddingTop,
        paddingRight,
        paddingBottom,
        paddingLeft,
        primaryAxisAlignItems,
        counterAxisAlignItems,
        layoutSizingHorizontal,
        layoutSizingVertical,
        itemSpacing
      });
      const typedResult = result;
      return {
        content: [
          {
            type: "text",
            text: `Created frame "${typedResult.name}" with ID: ${typedResult.id}. Use the ID as the parentId to appendChild inside this frame.`
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error creating frame: ${error instanceof Error ? error.message : String(error)}`
          }
        ]
      };
    }
  }
);
figmaTool(
  "create_text",
  "Create a new text element in Figma",
  {
    x: import_zod.z.number().describe("X position"),
    y: import_zod.z.number().describe("Y position"),
    text: import_zod.z.string().describe("Text content"),
    fontSize: import_zod.z.number().optional().describe("Font size (default: 14)"),
    fontWeight: import_zod.z.number().optional().describe("Font weight (e.g., 400 for Regular, 700 for Bold)"),
    fontColor: import_zod.z.object({
      r: import_zod.z.number().min(0).max(1).describe("Red component (0-1)"),
      g: import_zod.z.number().min(0).max(1).describe("Green component (0-1)"),
      b: import_zod.z.number().min(0).max(1).describe("Blue component (0-1)"),
      a: import_zod.z.number().min(0).max(1).optional().describe("Alpha component (0-1)")
    }).optional().describe("Font color in RGBA format"),
    name: import_zod.z.string().optional().describe("Semantic layer name for the text node"),
    parentId: import_zod.z.string().optional().describe("Optional parent node ID to append the text to")
  },
  async ({ x, y, text, fontSize, fontWeight, fontColor, name, parentId }) => {
    try {
      const result = await sendCommandToFigma("create_text", {
        x,
        y,
        text,
        fontSize: fontSize || 14,
        fontWeight: fontWeight || 400,
        fontColor: fontColor || { r: 0, g: 0, b: 0, a: 1 },
        name: name || "Text",
        parentId
      });
      const typedResult = result;
      return {
        content: [
          {
            type: "text",
            text: `Created text "${typedResult.name}" with ID: ${typedResult.id}`
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error creating text: ${error instanceof Error ? error.message : String(error)}`
          }
        ]
      };
    }
  }
);
figmaTool(
  "set_fill_color",
  "Set the fill color of a node in Figma can be TextNode or FrameNode",
  {
    nodeId: import_zod.z.string().describe("The ID of the node to modify"),
    r: import_zod.z.number().min(0).max(1).describe("Red component (0-1)"),
    g: import_zod.z.number().min(0).max(1).describe("Green component (0-1)"),
    b: import_zod.z.number().min(0).max(1).describe("Blue component (0-1)"),
    a: import_zod.z.number().min(0).max(1).optional().describe("Alpha component (0-1)")
  },
  async ({ nodeId, r, g, b, a }) => {
    try {
      const result = await sendCommandToFigma("set_fill_color", {
        nodeId,
        color: { r, g, b, a: a || 1 }
      });
      const typedResult = result;
      return {
        content: [
          {
            type: "text",
            text: `Set fill color of node "${typedResult.name}" to RGBA(${r}, ${g}, ${b}, ${a || 1})`
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting fill color: ${error instanceof Error ? error.message : String(error)}`
          }
        ]
      };
    }
  }
);
figmaTool(
  "set_stroke_color",
  "Set the stroke color of a node in Figma",
  {
    nodeId: import_zod.z.string().describe("The ID of the node to modify"),
    r: import_zod.z.number().min(0).max(1).describe("Red component (0-1)"),
    g: import_zod.z.number().min(0).max(1).describe("Green component (0-1)"),
    b: import_zod.z.number().min(0).max(1).describe("Blue component (0-1)"),
    a: import_zod.z.number().min(0).max(1).optional().describe("Alpha component (0-1)"),
    weight: import_zod.z.number().positive().optional().describe("Stroke weight")
  },
  async ({ nodeId, r, g, b, a, weight }) => {
    try {
      const result = await sendCommandToFigma("set_stroke_color", {
        nodeId,
        color: { r, g, b, a: a || 1 },
        weight: weight || 1
      });
      const typedResult = result;
      return {
        content: [
          {
            type: "text",
            text: `Set stroke color of node "${typedResult.name}" to RGBA(${r}, ${g}, ${b}, ${a || 1}) with weight ${weight || 1}`
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting stroke color: ${error instanceof Error ? error.message : String(error)}`
          }
        ]
      };
    }
  }
);
figmaTool(
  "move_node",
  "Move a node to a new position in Figma",
  {
    nodeId: import_zod.z.string().describe("The ID of the node to move"),
    x: import_zod.z.number().describe("New X position"),
    y: import_zod.z.number().describe("New Y position")
  },
  async ({ nodeId, x, y }) => {
    try {
      const result = await sendCommandToFigma("move_node", { nodeId, x, y });
      const typedResult = result;
      return {
        content: [
          {
            type: "text",
            text: `Moved node "${typedResult.name}" to position (${x}, ${y})`
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error moving node: ${error instanceof Error ? error.message : String(error)}`
          }
        ]
      };
    }
  }
);
figmaTool(
  "clone_node",
  "Clone an existing node in Figma",
  {
    nodeId: import_zod.z.string().describe("The ID of the node to clone"),
    x: import_zod.z.number().optional().describe("New X position for the clone"),
    y: import_zod.z.number().optional().describe("New Y position for the clone")
  },
  async ({ nodeId, x, y }) => {
    try {
      const result = await sendCommandToFigma("clone_node", { nodeId, x, y });
      const typedResult = result;
      return {
        content: [
          {
            type: "text",
            text: `Cloned node "${typedResult.name}" with new ID: ${typedResult.id}${x !== void 0 && y !== void 0 ? ` at position (${x}, ${y})` : ""}`
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error cloning node: ${error instanceof Error ? error.message : String(error)}`
          }
        ]
      };
    }
  }
);
figmaTool(
  "resize_node",
  "Resize a node in Figma",
  {
    nodeId: import_zod.z.string().describe("The ID of the node to resize"),
    width: import_zod.z.number().positive().describe("New width"),
    height: import_zod.z.number().positive().describe("New height")
  },
  async ({ nodeId, width, height }) => {
    try {
      const result = await sendCommandToFigma("resize_node", {
        nodeId,
        width,
        height
      });
      const typedResult = result;
      return {
        content: [
          {
            type: "text",
            text: `Resized node "${typedResult.name}" to width ${width} and height ${height}`
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error resizing node: ${error instanceof Error ? error.message : String(error)}`
          }
        ]
      };
    }
  }
);
figmaTool(
  "delete_node",
  "Delete a node from Figma",
  {
    nodeId: import_zod.z.string().describe("The ID of the node to delete")
  },
  async ({ nodeId }) => {
    try {
      await sendCommandToFigma("delete_node", { nodeId });
      return {
        content: [
          {
            type: "text",
            text: `Deleted node with ID: ${nodeId}`
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error deleting node: ${error instanceof Error ? error.message : String(error)}`
          }
        ]
      };
    }
  }
);
figmaTool(
  "delete_multiple_nodes",
  "Delete multiple nodes from Figma at once",
  {
    nodeIds: import_zod.z.array(import_zod.z.string()).describe("Array of node IDs to delete")
  },
  async ({ nodeIds }) => {
    try {
      const result = await sendCommandToFigma("delete_multiple_nodes", { nodeIds });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result)
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error deleting multiple nodes: ${error instanceof Error ? error.message : String(error)}`
          }
        ]
      };
    }
  }
);
figmaTool(
  "export_node_as_image",
  "Export a node from Figma. PNG/JPG: returns image (base64). SVG: returns plaintext XML plus an SVG image preview when the client supports it. PDF: returns base64 image block (binary preview). Optional writePath: for PNG/JPG write raw bytes; for SVG write UTF-8 markup (relative to MCP server cwd, no path traversal). Prefer export_node_as_svg when you only need SVG. Without an MCP client, same relay setup: run this binary with --export-png --channel=... --node=... --out=relative.png [--scale=4] [--port=3055].",
  {
    nodeId: import_zod.z.string().describe("The ID of the node to export"),
    format: import_zod.z.enum(["PNG", "JPG", "SVG", "PDF"]).optional().describe("Export format"),
    scale: import_zod.z.number().positive().optional().describe("Export scale (PNG/JPG only; ignored for SVG/PDF)"),
    writePath: import_zod.z.string().optional().describe(
      "If set: PNG/JPG write decoded raster bytes; SVG write UTF-8 XML. Path is relative to the MCP server cwd (no path traversal)."
    )
  },
  async ({ nodeId, format, scale, writePath }) => {
    try {
      const resolvedFormat = format || "PNG";
      const result = await sendCommandToFigma("export_node_as_image", {
        nodeId,
        format: resolvedFormat,
        scale: scale || 1
      });
      const typedResult = result;
      const mimeType = typedResult.mimeType || "image/png";
      if (resolvedFormat === "SVG" || mimeType === "image/svg+xml") {
        const parsed = parsePluginSvgExport(typedResult.imageData, nodeId);
        if (parsed.ok === false) {
          return {
            content: [{ type: "text", text: parsed.message }]
          };
        }
        return mcpContentForSvgExport({
          nodeId,
          imageDataBase64: typedResult.imageData,
          mimeType: typedResult.mimeType || "image/svg+xml",
          svg: parsed.svg,
          writePath,
          fromImageTool: true
        });
      }
      const content = [];
      if (writePath && (resolvedFormat === "PNG" || resolvedFormat === "JPG" || mimeType === "image/png" || mimeType === "image/jpeg")) {
        const abs = resolveWritePathUnderCwd(writePath);
        const buf = Buffer.from(typedResult.imageData, "base64");
        import_node_fs.default.mkdirSync(import_node_path.default.dirname(abs), { recursive: true });
        import_node_fs.default.writeFileSync(abs, buf);
        const rel = import_node_path.default.relative(process.cwd(), abs);
        content.push({
          type: "text",
          text: `Wrote ${rel} (${buf.byteLength} bytes).`
        });
      }
      content.push({
        type: "image",
        data: typedResult.imageData,
        mimeType
      });
      return { content };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error exporting node as image: ${error instanceof Error ? error.message : String(error)}`
          }
        ]
      };
    }
  }
);
async function runExportNodeAsSvgTool(params) {
  const result = await sendCommandToFigma("export_node_as_image", {
    nodeId: params.nodeId,
    format: "SVG",
    scale: 1
  });
  const typedResult = result;
  const parsed = parsePluginSvgExport(typedResult.imageData, params.nodeId);
  if (parsed.ok === false) {
    return { content: [{ type: "text", text: parsed.message }] };
  }
  return mcpContentForSvgExport({
    nodeId: params.nodeId,
    imageDataBase64: typedResult.imageData,
    mimeType: typedResult.mimeType || "image/svg+xml",
    svg: parsed.svg,
    writePath: params.writePath,
    fromImageTool: false
  });
}
figmaTool(
  "export_node_as_svg",
  "Export a Figma node as SVG: returns UTF-8 markup in the response and an SVG image preview when supported. Optional writePath writes a .svg file under the MCP server cwd (no path traversal). Use this instead of format SVG on export_node_as_image when you only need vector output.",
  {
    nodeId: import_zod.z.string().describe("The ID of the node to export as SVG"),
    writePath: import_zod.z.string().optional().describe(
      "If set, write UTF-8 SVG markup to this path relative to the MCP server cwd (no path traversal)."
    )
  },
  async ({ nodeId, writePath }) => {
    try {
      return await runExportNodeAsSvgTool({ nodeId, writePath });
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error exporting node as SVG: ${error instanceof Error ? error.message : String(error)}`
          }
        ]
      };
    }
  }
);
figmaTool(
  "copy_node_as_svg",
  "Alias of export_node_as_svg (identical parameters and behavior). Prefer export_node_as_svg in new workflows.",
  {
    nodeId: import_zod.z.string().describe("The ID of the node to export as SVG"),
    writePath: import_zod.z.string().optional().describe(
      "If set, write UTF-8 SVG markup to this path relative to the MCP server cwd (no path traversal)."
    )
  },
  async ({ nodeId, writePath }) => {
    try {
      return await runExportNodeAsSvgTool({ nodeId, writePath });
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error exporting SVG: ${error instanceof Error ? error.message : String(error)}`
          }
        ]
      };
    }
  }
);
figmaTool(
  "set_text_content",
  "Set the text content of an existing text node in Figma",
  {
    nodeId: import_zod.z.string().describe("The ID of the text node to modify"),
    text: import_zod.z.string().describe("New text content")
  },
  async ({ nodeId, text }) => {
    try {
      const result = await sendCommandToFigma("set_text_content", {
        nodeId,
        text
      });
      const typedResult = result;
      return {
        content: [
          {
            type: "text",
            text: `Updated text content of node "${typedResult.name}" to "${text}"`
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting text content: ${error instanceof Error ? error.message : String(error)}`
          }
        ]
      };
    }
  }
);
figmaTool(
  "get_styles",
  "Get all styles from the current Figma document",
  {},
  async () => {
    try {
      const result = await sendCommandToFigma("get_styles");
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result)
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error getting styles: ${error instanceof Error ? error.message : String(error)}`
          }
        ]
      };
    }
  }
);
figmaTool(
  "get_local_components",
  "Get all local components from the Figma document",
  {},
  async () => {
    try {
      const result = await sendCommandToFigma("get_local_components");
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result)
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error getting local components: ${error instanceof Error ? error.message : String(error)}`
          }
        ]
      };
    }
  }
);
figmaTool(
  "get_annotations",
  "Get all annotations in the current document or specific node",
  {
    nodeId: import_zod.z.string().describe("node ID to get annotations for specific node"),
    includeCategories: import_zod.z.boolean().optional().default(true).describe("Whether to include category information")
  },
  async ({ nodeId, includeCategories }) => {
    try {
      const result = await sendCommandToFigma("get_annotations", {
        nodeId,
        includeCategories
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result)
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error getting annotations: ${error instanceof Error ? error.message : String(error)}`
          }
        ]
      };
    }
  }
);
figmaTool(
  "set_annotation",
  "Create or update an annotation",
  {
    nodeId: import_zod.z.string().describe("The ID of the node to annotate"),
    annotationId: import_zod.z.string().optional().describe("The ID of the annotation to update (if updating existing annotation)"),
    labelMarkdown: import_zod.z.string().describe("The annotation text in markdown format"),
    categoryId: import_zod.z.string().optional().describe("The ID of the annotation category"),
    properties: import_zod.z.array(import_zod.z.object({
      type: import_zod.z.string()
    })).optional().describe("Additional properties for the annotation")
  },
  async ({ nodeId, annotationId, labelMarkdown, categoryId, properties }) => {
    try {
      const result = await sendCommandToFigma("set_annotation", {
        nodeId,
        annotationId,
        labelMarkdown,
        categoryId,
        properties
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result)
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting annotation: ${error instanceof Error ? error.message : String(error)}`
          }
        ]
      };
    }
  }
);
figmaTool(
  "set_multiple_annotations",
  "Set multiple annotations parallelly in a node",
  {
    nodeId: import_zod.z.string().describe("The ID of the node containing the elements to annotate"),
    annotations: import_zod.z.array(
      import_zod.z.object({
        nodeId: import_zod.z.string().describe("The ID of the node to annotate"),
        labelMarkdown: import_zod.z.string().describe("The annotation text in markdown format"),
        categoryId: import_zod.z.string().optional().describe("The ID of the annotation category"),
        annotationId: import_zod.z.string().optional().describe("The ID of the annotation to update (if updating existing annotation)"),
        properties: import_zod.z.array(import_zod.z.object({
          type: import_zod.z.string()
        })).optional().describe("Additional properties for the annotation")
      })
    ).describe("Array of annotations to apply")
  },
  async ({ nodeId, annotations }) => {
    try {
      if (!annotations || annotations.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No annotations provided"
            }
          ]
        };
      }
      const initialStatus = {
        type: "text",
        text: `Starting annotation process for ${annotations.length} nodes. This will be processed in batches of 5...`
      };
      let totalProcessed = 0;
      const totalToProcess = annotations.length;
      const result = await sendCommandToFigma("set_multiple_annotations", {
        nodeId,
        annotations
      });
      const typedResult = result;
      const success = typedResult.annotationsApplied && typedResult.annotationsApplied > 0;
      const progressText = `
      Annotation process completed:
      - ${typedResult.annotationsApplied || 0} of ${totalToProcess} successfully applied
      - ${typedResult.annotationsFailed || 0} failed
      - Processed in ${typedResult.completedInChunks || 1} batches
      `;
      const detailedResults = typedResult.results || [];
      const failedResults = detailedResults.filter((item) => !item.success);
      let detailedResponse = "";
      if (failedResults.length > 0) {
        detailedResponse = `

Nodes that failed:
${failedResults.map(
          (item) => `- ${item.nodeId}: ${item.error || "Unknown error"}`
        ).join("\n")}`;
      }
      return {
        content: [
          initialStatus,
          {
            type: "text",
            text: progressText + detailedResponse
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting multiple annotations: ${error instanceof Error ? error.message : String(error)}`
          }
        ]
      };
    }
  }
);
figmaTool(
  "create_component_instance",
  "Create an instance of a component in Figma. For LOCAL components (from get_local_components), use componentId with the id field. For published LIBRARY components, use componentKey with the publishedKey field.",
  {
    componentId: import_zod.z.string().optional().describe("ID of a local component (use the id field from get_local_components result). Use this for unpublished/local components."),
    componentKey: import_zod.z.string().optional().describe("Key of a published library component to instantiate (use the publishedKey field from get_local_components result). Only works for published components."),
    x: import_zod.z.number().describe("X position"),
    y: import_zod.z.number().describe("Y position"),
    parentId: import_zod.z.string().optional().describe("Optional parent node ID to place the instance into")
  },
  async ({ componentId, componentKey, x, y, parentId }) => {
    try {
      const result = await sendCommandToFigma("create_component_instance", {
        componentId,
        componentKey,
        x,
        y,
        parentId
      });
      const typedResult = result;
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(typedResult)
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error creating component instance: ${error instanceof Error ? error.message : String(error)}`
          }
        ]
      };
    }
  }
);
figmaTool(
  "get_instance_overrides",
  "Get all override properties from a selected component instance. These overrides can be applied to other instances, which will swap them to match the source component.",
  {
    nodeId: import_zod.z.string().optional().describe("Optional ID of the component instance to get overrides from. If not provided, currently selected instance will be used.")
  },
  async ({ nodeId }) => {
    try {
      const result = await sendCommandToFigma("get_instance_overrides", {
        instanceNodeId: nodeId || null
      });
      const typedResult = result;
      return {
        content: [
          {
            type: "text",
            text: typedResult.success ? `Successfully got instance overrides: ${typedResult.message}` : `Failed to get instance overrides: ${typedResult.message}`
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error copying instance overrides: ${error instanceof Error ? error.message : String(error)}`
          }
        ]
      };
    }
  }
);
figmaTool(
  "set_instance_overrides",
  "Apply previously copied overrides to selected component instances. Target instances will be swapped to the source component and all copied override properties will be applied.",
  {
    sourceInstanceId: import_zod.z.string().describe("ID of the source component instance"),
    targetNodeIds: import_zod.z.array(import_zod.z.string()).describe("Array of target instance IDs. Currently selected instances will be used.")
  },
  async ({ sourceInstanceId, targetNodeIds }) => {
    try {
      const result = await sendCommandToFigma("set_instance_overrides", {
        sourceInstanceId,
        targetNodeIds: targetNodeIds || []
      });
      const typedResult = result;
      if (typedResult.success) {
        const successCount = typedResult.results?.filter((r) => r.success).length || 0;
        return {
          content: [
            {
              type: "text",
              text: `Successfully applied ${typedResult.totalCount || 0} overrides to ${successCount} instances.`
            }
          ]
        };
      } else {
        return {
          content: [
            {
              type: "text",
              text: `Failed to set instance overrides: ${typedResult.message}`
            }
          ]
        };
      }
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting instance overrides: ${error instanceof Error ? error.message : String(error)}`
          }
        ]
      };
    }
  }
);
figmaTool(
  "set_corner_radius",
  "Set the corner radius of a node in Figma",
  {
    nodeId: import_zod.z.string().describe("The ID of the node to modify"),
    radius: import_zod.z.number().min(0).describe("Corner radius value"),
    corners: import_zod.z.array(import_zod.z.boolean()).length(4).optional().describe(
      "Optional array of 4 booleans to specify which corners to round [topLeft, topRight, bottomRight, bottomLeft]"
    )
  },
  async ({ nodeId, radius, corners }) => {
    try {
      const result = await sendCommandToFigma("set_corner_radius", {
        nodeId,
        radius,
        corners: corners || [true, true, true, true]
      });
      const typedResult = result;
      return {
        content: [
          {
            type: "text",
            text: `Set corner radius of node "${typedResult.name}" to ${radius}px`
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting corner radius: ${error instanceof Error ? error.message : String(error)}`
          }
        ]
      };
    }
  }
);
figmaPrompt(
  "design_strategy",
  "Best practices for working with Figma designs",
  (extra) => {
    return {
      messages: [
        {
          role: "assistant",
          content: {
            type: "text",
            text: `When working with Figma designs, follow these best practices:

1. Start with Document Structure:
   - First use get_document_info() to understand the current document
   - Plan your layout hierarchy before creating elements
   - Create a main container frame for each screen/section

2. Naming Conventions:
   - Use descriptive, semantic names for all elements
   - Follow a consistent naming pattern (e.g., "Login Screen", "Logo Container", "Email Input")
   - Group related elements with meaningful names

3. Layout Hierarchy:
   - Create parent frames first, then add child elements
   - For forms/login screens:
     * Start with the main screen container frame
     * Create a logo container at the top
     * Group input fields in their own containers
     * Place action buttons (login, submit) after inputs
     * Add secondary elements (forgot password, signup links) last

4. Input Fields Structure:
   - Create a container frame for each input field
   - Include a label text above or inside the input
   - Group related inputs (e.g., username/password) together

5. Element Creation:
   - Use create_frame() for containers and input fields
   - Use create_text() for labels, buttons text, and links
   - Set appropriate colors and styles:
     * Use fillColor for backgrounds
     * Use strokeColor for borders
     * Set proper fontWeight for different text elements

6. Mofifying existing elements:
  - use set_text_content() to modify text content.

7. Visual Hierarchy:
   - Position elements in logical reading order (top to bottom)
   - Maintain consistent spacing between elements
   - Use appropriate font sizes for different text types:
     * Larger for headings/welcome text
     * Medium for input labels
     * Standard for button text
     * Smaller for helper text/links

8. Best Practices:
   - Verify each creation with get_node_info()
   - Use parentId to maintain proper hierarchy
   - Group related elements together in frames
   - Keep consistent spacing and alignment

Example Login Screen Structure:
- Login Screen (main frame)
  - Logo Container (frame)
    - Logo (image/text)
  - Welcome Text (text)
  - Input Container (frame)
    - Email Input (frame)
      - Email Label (text)
      - Email Field (frame)
    - Password Input (frame)
      - Password Label (text)
      - Password Field (frame)
  - Login Button (frame)
    - Button Text (text)
  - Helper Links (frame)
    - Forgot Password (text)
    - Don't have account (text)`
          }
        }
      ],
      description: "Best practices for working with Figma designs"
    };
  }
);
figmaTool(
  "scan_text_nodes",
  "Scan all text nodes in the selected Figma node",
  {
    nodeId: import_zod.z.string().describe("ID of the node to scan")
  },
  async ({ nodeId }) => {
    try {
      const initialStatus = {
        type: "text",
        text: "Starting text node scanning. This may take a moment for large designs..."
      };
      const result = await sendCommandToFigma("scan_text_nodes", {
        nodeId,
        useChunking: true,
        // Enable chunking on the plugin side
        chunkSize: 10
        // Process 10 nodes at a time
      });
      if (result && typeof result === "object" && "chunks" in result) {
        const typedResult = result;
        const summaryText = `
        Scan completed:
        - Found ${typedResult.totalNodes} text nodes
        - Processed in ${typedResult.chunks} chunks
        `;
        return {
          content: [
            initialStatus,
            {
              type: "text",
              text: summaryText
            },
            {
              type: "text",
              text: JSON.stringify(typedResult.textNodes, null, 2)
            }
          ]
        };
      }
      return {
        content: [
          initialStatus,
          {
            type: "text",
            text: JSON.stringify(result, null, 2)
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error scanning text nodes: ${error instanceof Error ? error.message : String(error)}`
          }
        ]
      };
    }
  }
);
figmaTool(
  "scan_nodes_by_types",
  "Scan for child nodes with specific types in the selected Figma node",
  {
    nodeId: import_zod.z.string().describe("ID of the node to scan"),
    types: import_zod.z.array(import_zod.z.string()).describe("Array of node types to find in the child nodes (e.g. ['COMPONENT', 'FRAME'])")
  },
  async ({ nodeId, types }) => {
    try {
      const initialStatus = {
        type: "text",
        text: `Starting node type scanning for types: ${types.join(", ")}...`
      };
      const result = await sendCommandToFigma("scan_nodes_by_types", {
        nodeId,
        types
      });
      if (result && typeof result === "object" && "matchingNodes" in result) {
        const typedResult = result;
        const summaryText = `Scan completed: Found ${typedResult.count} nodes matching types: ${typedResult.searchedTypes.join(", ")}`;
        return {
          content: [
            initialStatus,
            {
              type: "text",
              text: summaryText
            },
            {
              type: "text",
              text: JSON.stringify(typedResult.matchingNodes, null, 2)
            }
          ]
        };
      }
      return {
        content: [
          initialStatus,
          {
            type: "text",
            text: JSON.stringify(result, null, 2)
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error scanning nodes by types: ${error instanceof Error ? error.message : String(error)}`
          }
        ]
      };
    }
  }
);
figmaPrompt(
  "text_replacement_strategy",
  "Systematic approach for replacing text in Figma designs",
  (extra) => {
    return {
      messages: [
        {
          role: "assistant",
          content: {
            type: "text",
            text: `# Intelligent Text Replacement Strategy

## 1. Analyze Design & Identify Structure
- Scan text nodes to understand the overall structure of the design
- Use AI pattern recognition to identify logical groupings:
  * Tables (rows, columns, headers, cells)
  * Lists (items, headers, nested lists)
  * Card groups (similar cards with recurring text fields)
  * Forms (labels, input fields, validation text)
  * Navigation (menu items, breadcrumbs)
\`\`\`
scan_text_nodes(nodeId: "node-id")
get_node_info(nodeId: "node-id")  // optional
\`\`\`

## 2. Strategic Chunking for Complex Designs
- Divide replacement tasks into logical content chunks based on design structure
- Use one of these chunking strategies that best fits the design:
  * **Structural Chunking**: Table rows/columns, list sections, card groups
  * **Spatial Chunking**: Top-to-bottom, left-to-right in screen areas
  * **Semantic Chunking**: Content related to the same topic or functionality
  * **Component-Based Chunking**: Process similar component instances together

## 3. Progressive Replacement with Verification
- Create a safe copy of the node for text replacement
- Replace text chunk by chunk with continuous progress updates
- After each chunk is processed:
  * Export that section as a small, manageable image
  * Verify text fits properly and maintain design integrity
  * Fix issues before proceeding to the next chunk

\`\`\`
// Clone the node to create a safe copy
clone_node(nodeId: "selected-node-id", x: [new-x], y: [new-y])

// Replace text chunk by chunk
set_multiple_text_contents(
  nodeId: "parent-node-id", 
  text: [
    { nodeId: "node-id-1", text: "New text 1" },
    // More nodes in this chunk...
  ]
)

// Verify chunk with small, targeted image exports
export_node_as_image(nodeId: "chunk-node-id", format: "PNG", scale: 0.5)
\`\`\`

## 4. Intelligent Handling for Table Data
- For tabular content:
  * Process one row or column at a time
  * Maintain alignment and spacing between cells
  * Consider conditional formatting based on cell content
  * Preserve header/data relationships

## 5. Smart Text Adaptation
- Adaptively handle text based on container constraints:
  * Auto-detect space constraints and adjust text length
  * Apply line breaks at appropriate linguistic points
  * Maintain text hierarchy and emphasis
  * Consider font scaling for critical content that must fit

## 6. Progressive Feedback Loop
- Establish a continuous feedback loop during replacement:
  * Real-time progress updates (0-100%)
  * Small image exports after each chunk for verification
  * Issues identified early and resolved incrementally
  * Quick adjustments applied to subsequent chunks

## 7. Final Verification & Context-Aware QA
- After all chunks are processed:
  * Export the entire design at reduced scale for final verification
  * Check for cross-chunk consistency issues
  * Verify proper text flow between different sections
  * Ensure design harmony across the full composition

## 8. Chunk-Specific Export Scale Guidelines
- Scale exports appropriately based on chunk size:
  * Small chunks (1-5 elements): scale 1.0
  * Medium chunks (6-20 elements): scale 0.7
  * Large chunks (21-50 elements): scale 0.5
  * Very large chunks (50+ elements): scale 0.3
  * Full design verification: scale 0.2

## Sample Chunking Strategy for Common Design Types

### Tables
- Process by logical rows (5-10 rows per chunk)
- Alternative: Process by column for columnar analysis
- Tip: Always include header row in first chunk for reference

### Card Lists
- Group 3-5 similar cards per chunk
- Process entire cards to maintain internal consistency
- Verify text-to-image ratio within cards after each chunk

### Forms
- Group related fields (e.g., "Personal Information", "Payment Details")
- Process labels and input fields together
- Ensure validation messages and hints are updated with their fields

### Navigation & Menus
- Process hierarchical levels together (main menu, submenu)
- Respect information architecture relationships
- Verify menu fit and alignment after replacement

## Best Practices
- **Preserve Design Intent**: Always prioritize design integrity
- **Structural Consistency**: Maintain alignment, spacing, and hierarchy
- **Visual Feedback**: Verify each chunk visually before proceeding
- **Incremental Improvement**: Learn from each chunk to improve subsequent ones
- **Balance Automation & Control**: Let AI handle repetitive replacements but maintain oversight
- **Respect Content Relationships**: Keep related content consistent across chunks

Remember that text is never just text\u2014it's a core design element that must work harmoniously with the overall composition. This chunk-based strategy allows you to methodically transform text while maintaining design integrity.`
          }
        }
      ],
      description: "Systematic approach for replacing text in Figma designs"
    };
  }
);
figmaTool(
  "set_multiple_text_contents",
  "Set multiple text contents parallelly in a node",
  {
    nodeId: import_zod.z.string().describe("The ID of the node containing the text nodes to replace"),
    text: import_zod.z.array(
      import_zod.z.object({
        nodeId: import_zod.z.string().describe("The ID of the text node"),
        text: import_zod.z.string().describe("The replacement text")
      })
    ).describe("Array of text node IDs and their replacement texts")
  },
  async ({ nodeId, text }) => {
    try {
      if (!text || text.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No text provided"
            }
          ]
        };
      }
      const initialStatus = {
        type: "text",
        text: `Starting text replacement for ${text.length} nodes. This will be processed in batches of 5...`
      };
      let totalProcessed = 0;
      const totalToProcess = text.length;
      const result = await sendCommandToFigma("set_multiple_text_contents", {
        nodeId,
        text
      });
      const typedResult = result;
      const success = typedResult.replacementsApplied && typedResult.replacementsApplied > 0;
      const progressText = `
      Text replacement completed:
      - ${typedResult.replacementsApplied || 0} of ${totalToProcess} successfully updated
      - ${typedResult.replacementsFailed || 0} failed
      - Processed in ${typedResult.completedInChunks || 1} batches
      `;
      const detailedResults = typedResult.results || [];
      const failedResults = detailedResults.filter((item) => !item.success);
      let detailedResponse = "";
      if (failedResults.length > 0) {
        detailedResponse = `

Nodes that failed:
${failedResults.map(
          (item) => `- ${item.nodeId}: ${item.error || "Unknown error"}`
        ).join("\n")}`;
      }
      return {
        content: [
          initialStatus,
          {
            type: "text",
            text: progressText + detailedResponse
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting multiple text contents: ${error instanceof Error ? error.message : String(error)}`
          }
        ]
      };
    }
  }
);
figmaPrompt(
  "annotation_conversion_strategy",
  "Strategy for converting manual annotations to Figma's native annotations",
  (extra) => {
    return {
      messages: [
        {
          role: "assistant",
          content: {
            type: "text",
            text: `# Automatic Annotation Conversion
            
## Process Overview

The process of converting manual annotations (numbered/alphabetical indicators with connected descriptions) to Figma's native annotations:

1. Get selected frame/component information
2. Scan and collect all annotation text nodes
3. Scan target UI elements (components, instances, frames)
4. Match annotations to appropriate UI elements
5. Apply native Figma annotations

## Step 1: Get Selection and Initial Setup

First, get the selected frame or component that contains annotations:

\`\`\`typescript
// Get the selected frame/component
const selection = await get_selection();
const selectedNodeId = selection[0].id

// Get available annotation categories for later use
const annotationData = await get_annotations({
  nodeId: selectedNodeId,
  includeCategories: true
});
const categories = annotationData.categories;
\`\`\`

## Step 2: Scan Annotation Text Nodes

Scan all text nodes to identify annotations and their descriptions:

\`\`\`typescript
// Get all text nodes in the selection
const textNodes = await scan_text_nodes({
  nodeId: selectedNodeId
});

// Filter and group annotation markers and descriptions

// Markers typically have these characteristics:
// - Short text content (usually single digit/letter)
// - Specific font styles (often bold)
// - Located in a container with "Marker" or "Dot" in the name
// - Have a clear naming pattern (e.g., "1", "2", "3" or "A", "B", "C")


// Identify description nodes
// Usually longer text nodes near markers or with matching numbers in path
  
\`\`\`

## Step 3: Scan Target UI Elements

Get all potential target elements that annotations might refer to:

\`\`\`typescript
// Scan for all UI elements that could be annotation targets
const targetNodes = await scan_nodes_by_types({
  nodeId: selectedNodeId,
  types: [
    "COMPONENT",
    "INSTANCE",
    "FRAME"
  ]
});
\`\`\`

## Step 4: Match Annotations to Targets

Match each annotation to its target UI element using these strategies in order of priority:

1. **Path-Based Matching**:
   - Look at the marker's parent container name in the Figma layer hierarchy
   - Remove any "Marker:" or "Annotation:" prefixes from the parent name
   - Find UI elements that share the same parent name or have it in their path
   - This works well when markers are grouped with their target elements

2. **Name-Based Matching**:
   - Extract key terms from the annotation description
   - Look for UI elements whose names contain these key terms
   - Consider both exact matches and semantic similarities
   - Particularly effective for form fields, buttons, and labeled components

3. **Proximity-Based Matching** (fallback):
   - Calculate the center point of the marker
   - Find the closest UI element by measuring distances to element centers
   - Consider the marker's position relative to nearby elements
   - Use this method when other matching strategies fail

Additional Matching Considerations:
- Give higher priority to matches found through path-based matching
- Consider the type of UI element when evaluating matches
- Take into account the annotation's context and content
- Use a combination of strategies for more accurate matching

## Step 5: Apply Native Annotations

Convert matched annotations to Figma's native annotations using batch processing:

\`\`\`typescript
// Prepare annotations array for batch processing
const annotationsToApply = Object.values(annotations).map(({ marker, description }) => {
  // Find target using multiple strategies
  const target = 
    findTargetByPath(marker, targetNodes) ||
    findTargetByName(description, targetNodes) ||
    findTargetByProximity(marker, targetNodes);
  
  if (target) {
    // Determine appropriate category based on content
    const category = determineCategory(description.characters, categories);

    // Determine appropriate additional annotationProperty based on content
    const annotationProperty = determineProperties(description.characters, target.type);
    
    return {
      nodeId: target.id,
      labelMarkdown: description.characters,
      categoryId: category.id,
      properties: annotationProperty
    };
  }
  return null;
}).filter(Boolean); // Remove null entries

// Apply annotations in batches using set_multiple_annotations
if (annotationsToApply.length > 0) {
  await set_multiple_annotations({
    nodeId: selectedNodeId,
    annotations: annotationsToApply
  });
}
\`\`\`


This strategy focuses on practical implementation based on real-world usage patterns, emphasizing the importance of handling various UI elements as annotation targets, not just text nodes.`
          }
        }
      ],
      description: "Strategy for converting manual annotations to Figma's native annotations"
    };
  }
);
figmaPrompt(
  "swap_overrides_instances",
  "Guide to swap instance overrides between instances",
  (extra) => {
    return {
      messages: [
        {
          role: "assistant",
          content: {
            type: "text",
            text: `# Swap Component Instance and Override Strategy

## Overview
This strategy enables transferring content and property overrides from a source instance to one or more target instances in Figma, maintaining design consistency while reducing manual work.

## Step-by-Step Process

### 1. Selection Analysis
- Use \`get_selection()\` to identify the parent component or selected instances
- For parent components, scan for instances with \`scan_nodes_by_types({ nodeId: "parent-id", types: ["INSTANCE"] })\`
- Identify custom slots by name patterns (e.g. "Custom Slot*" or "Instance Slot") or by examining text content
- Determine which is the source instance (with content to copy) and which are targets (where to apply content)

### 2. Extract Source Overrides
- Use \`get_instance_overrides()\` to extract customizations from the source instance
- This captures text content, property values, and style overrides
- Command syntax: \`get_instance_overrides({ nodeId: "source-instance-id" })\`
- Look for successful response like "Got component information from [instance name]"

### 3. Apply Overrides to Targets
- Apply captured overrides using \`set_instance_overrides()\`
- Command syntax:
  \`\`\`
  set_instance_overrides({
    sourceInstanceId: "source-instance-id", 
    targetNodeIds: ["target-id-1", "target-id-2", ...]
  })
  \`\`\`

### 4. Verification
- Verify results with \`get_node_info()\` or \`read_my_design()\`
- Confirm text content and style overrides have transferred successfully

## Key Tips
- Always join the appropriate channel first with \`join_channel()\`
- When working with multiple targets, check the full selection with \`get_selection()\`
- Preserve component relationships by using instance overrides rather than direct text manipulation`
          }
        }
      ],
      description: "Strategy for transferring overrides between component instances in Figma"
    };
  }
);
figmaTool(
  "set_layout_mode",
  "Set the layout mode and wrap behavior of a frame in Figma",
  {
    nodeId: import_zod.z.string().describe("The ID of the frame to modify"),
    layoutMode: import_zod.z.enum(["NONE", "HORIZONTAL", "VERTICAL"]).describe("Layout mode for the frame"),
    layoutWrap: import_zod.z.enum(["NO_WRAP", "WRAP"]).optional().describe("Whether the auto-layout frame wraps its children")
  },
  async ({ nodeId, layoutMode, layoutWrap }) => {
    try {
      const result = await sendCommandToFigma("set_layout_mode", {
        nodeId,
        layoutMode,
        layoutWrap: layoutWrap || "NO_WRAP"
      });
      const typedResult = result;
      return {
        content: [
          {
            type: "text",
            text: `Set layout mode of frame "${typedResult.name}" to ${layoutMode}${layoutWrap ? ` with ${layoutWrap}` : ""}`
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting layout mode: ${error instanceof Error ? error.message : String(error)}`
          }
        ]
      };
    }
  }
);
figmaTool(
  "set_padding",
  "Set padding values for an auto-layout frame in Figma",
  {
    nodeId: import_zod.z.string().describe("The ID of the frame to modify"),
    paddingTop: import_zod.z.number().optional().describe("Top padding value"),
    paddingRight: import_zod.z.number().optional().describe("Right padding value"),
    paddingBottom: import_zod.z.number().optional().describe("Bottom padding value"),
    paddingLeft: import_zod.z.number().optional().describe("Left padding value")
  },
  async ({ nodeId, paddingTop, paddingRight, paddingBottom, paddingLeft }) => {
    try {
      const result = await sendCommandToFigma("set_padding", {
        nodeId,
        paddingTop,
        paddingRight,
        paddingBottom,
        paddingLeft
      });
      const typedResult = result;
      const paddingMessages = [];
      if (paddingTop !== void 0) paddingMessages.push(`top: ${paddingTop}`);
      if (paddingRight !== void 0) paddingMessages.push(`right: ${paddingRight}`);
      if (paddingBottom !== void 0) paddingMessages.push(`bottom: ${paddingBottom}`);
      if (paddingLeft !== void 0) paddingMessages.push(`left: ${paddingLeft}`);
      const paddingText = paddingMessages.length > 0 ? `padding (${paddingMessages.join(", ")})` : "padding";
      return {
        content: [
          {
            type: "text",
            text: `Set ${paddingText} for frame "${typedResult.name}"`
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting padding: ${error instanceof Error ? error.message : String(error)}`
          }
        ]
      };
    }
  }
);
figmaTool(
  "set_axis_align",
  "Set primary and counter axis alignment for an auto-layout frame in Figma",
  {
    nodeId: import_zod.z.string().describe("The ID of the frame to modify"),
    primaryAxisAlignItems: import_zod.z.enum(["MIN", "MAX", "CENTER", "SPACE_BETWEEN"]).optional().describe("Primary axis alignment (MIN/MAX = left/right in horizontal, top/bottom in vertical). Note: When set to SPACE_BETWEEN, itemSpacing will be ignored as children will be evenly spaced."),
    counterAxisAlignItems: import_zod.z.enum(["MIN", "MAX", "CENTER", "BASELINE"]).optional().describe("Counter axis alignment (MIN/MAX = top/bottom in horizontal, left/right in vertical)")
  },
  async ({ nodeId, primaryAxisAlignItems, counterAxisAlignItems }) => {
    try {
      const result = await sendCommandToFigma("set_axis_align", {
        nodeId,
        primaryAxisAlignItems,
        counterAxisAlignItems
      });
      const typedResult = result;
      const alignMessages = [];
      if (primaryAxisAlignItems !== void 0) alignMessages.push(`primary: ${primaryAxisAlignItems}`);
      if (counterAxisAlignItems !== void 0) alignMessages.push(`counter: ${counterAxisAlignItems}`);
      const alignText = alignMessages.length > 0 ? `axis alignment (${alignMessages.join(", ")})` : "axis alignment";
      return {
        content: [
          {
            type: "text",
            text: `Set ${alignText} for frame "${typedResult.name}"`
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting axis alignment: ${error instanceof Error ? error.message : String(error)}`
          }
        ]
      };
    }
  }
);
figmaTool(
  "set_layout_sizing",
  "Set horizontal and vertical sizing modes for an auto-layout frame in Figma",
  {
    nodeId: import_zod.z.string().describe("The ID of the frame to modify"),
    layoutSizingHorizontal: import_zod.z.enum(["FIXED", "HUG", "FILL"]).optional().describe("Horizontal sizing mode (HUG for frames/text only, FILL for auto-layout children only)"),
    layoutSizingVertical: import_zod.z.enum(["FIXED", "HUG", "FILL"]).optional().describe("Vertical sizing mode (HUG for frames/text only, FILL for auto-layout children only)")
  },
  async ({ nodeId, layoutSizingHorizontal, layoutSizingVertical }) => {
    try {
      const result = await sendCommandToFigma("set_layout_sizing", {
        nodeId,
        layoutSizingHorizontal,
        layoutSizingVertical
      });
      const typedResult = result;
      const sizingMessages = [];
      if (layoutSizingHorizontal !== void 0) sizingMessages.push(`horizontal: ${layoutSizingHorizontal}`);
      if (layoutSizingVertical !== void 0) sizingMessages.push(`vertical: ${layoutSizingVertical}`);
      const sizingText = sizingMessages.length > 0 ? `layout sizing (${sizingMessages.join(", ")})` : "layout sizing";
      return {
        content: [
          {
            type: "text",
            text: `Set ${sizingText} for frame "${typedResult.name}"`
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting layout sizing: ${error instanceof Error ? error.message : String(error)}`
          }
        ]
      };
    }
  }
);
figmaTool(
  "set_item_spacing",
  "Set distance between children in an auto-layout frame",
  {
    nodeId: import_zod.z.string().describe("The ID of the frame to modify"),
    itemSpacing: import_zod.z.number().optional().describe("Distance between children. Note: This value will be ignored if primaryAxisAlignItems is set to SPACE_BETWEEN."),
    counterAxisSpacing: import_zod.z.number().optional().describe("Distance between wrapped rows/columns. Only works when layoutWrap is set to WRAP.")
  },
  async ({ nodeId, itemSpacing, counterAxisSpacing }) => {
    try {
      const params = { nodeId };
      if (itemSpacing !== void 0) params.itemSpacing = itemSpacing;
      if (counterAxisSpacing !== void 0) params.counterAxisSpacing = counterAxisSpacing;
      const result = await sendCommandToFigma("set_item_spacing", params);
      const typedResult = result;
      let message = `Updated spacing for frame "${typedResult.name}":`;
      if (itemSpacing !== void 0) message += ` itemSpacing=${itemSpacing}`;
      if (counterAxisSpacing !== void 0) message += ` counterAxisSpacing=${counterAxisSpacing}`;
      return {
        content: [
          {
            type: "text",
            text: message
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting spacing: ${error instanceof Error ? error.message : String(error)}`
          }
        ]
      };
    }
  }
);
figmaTool(
  "set_default_connector",
  "Set a copied connector node as the default connector",
  {
    connectorId: import_zod.z.string().optional().describe("The ID of the connector node to set as default")
  },
  async ({ connectorId }) => {
    try {
      const result = await sendCommandToFigma("set_default_connector", {
        connectorId
      });
      return {
        content: [
          {
            type: "text",
            text: `Default connector set: ${JSON.stringify(result)}`
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting default connector: ${error instanceof Error ? error.message : String(error)}`
          }
        ]
      };
    }
  }
);
figmaTool(
  "create_connections",
  "Create connections between nodes using the default connector style",
  {
    connections: import_zod.z.array(import_zod.z.object({
      startNodeId: import_zod.z.string().describe("ID of the starting node"),
      endNodeId: import_zod.z.string().describe("ID of the ending node"),
      text: import_zod.z.string().optional().describe("Optional text to display on the connector")
    })).describe("Array of node connections to create")
  },
  async ({ connections }) => {
    try {
      if (!connections || connections.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No connections provided"
            }
          ]
        };
      }
      const result = await sendCommandToFigma("create_connections", {
        connections
      });
      return {
        content: [
          {
            type: "text",
            text: `Created ${connections.length} connections: ${JSON.stringify(result)}`
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error creating connections: ${error instanceof Error ? error.message : String(error)}`
          }
        ]
      };
    }
  }
);
figmaTool(
  "set_focus",
  "Set focus on a specific node in Figma by selecting it and scrolling viewport to it",
  {
    nodeId: import_zod.z.string().describe("The ID of the node to focus on")
  },
  async ({ nodeId }) => {
    try {
      const result = await sendCommandToFigma("set_focus", { nodeId });
      const typedResult = result;
      return {
        content: [
          {
            type: "text",
            text: `Focused on node "${typedResult.name}" (ID: ${typedResult.id})`
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting focus: ${error instanceof Error ? error.message : String(error)}`
          }
        ]
      };
    }
  }
);
figmaTool(
  "set_selections",
  "Set selection to multiple nodes in Figma and scroll viewport to show them",
  {
    nodeIds: import_zod.z.array(import_zod.z.string()).describe("Array of node IDs to select")
  },
  async ({ nodeIds }) => {
    try {
      const result = await sendCommandToFigma("set_selections", { nodeIds });
      const typedResult = result;
      return {
        content: [
          {
            type: "text",
            text: `Selected ${typedResult.count} nodes: ${typedResult.selectedNodes.map((node) => `"${node.name}" (${node.id})`).join(", ")}`
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting selections: ${error instanceof Error ? error.message : String(error)}`
          }
        ]
      };
    }
  }
);
function connectToFigma(port = FIGMA_SOCKET_PORT) {
  if (ws && ws.readyState === import_ws.default.OPEN) {
    logger.info("Already connected to Figma");
    return;
  }
  const wsUrl = serverUrl === "localhost" ? `${WS_URL}:${port}` : WS_URL;
  logger.info(`Connecting to Figma socket server at ${wsUrl}...`);
  ws = new import_ws.default(wsUrl);
  ws.on("open", () => {
    logger.info("Connected to Figma socket server");
    currentChannel = null;
    currentChannelDescription = null;
  });
  ws.on("message", (data) => {
    try {
      const json = JSON.parse(data);
      if (json.type === "channel_list" && typeof json.id === "string" && pendingRequests.has(json.id)) {
        const request = pendingRequests.get(json.id);
        clearTimeout(request.timeout);
        pendingRequests.delete(json.id);
        request.resolve(Array.isArray(json.channels) ? json.channels : []);
        return;
      }
      if (json.type === "progress_update") {
        const progressData = json.message.data;
        const requestId = json.id || "";
        if (requestId && pendingRequests.has(requestId)) {
          const request = pendingRequests.get(requestId);
          request.lastActivity = Date.now();
          clearTimeout(request.timeout);
          request.timeout = setTimeout(() => {
            if (pendingRequests.has(requestId)) {
              logger.error(`Request ${requestId} timed out after extended period of inactivity`);
              pendingRequests.delete(requestId);
              request.reject(new Error("Request to Figma timed out"));
            }
          }, 6e4);
          logger.info(`Progress update for ${progressData.commandType}: ${progressData.progress}% - ${progressData.message}`);
          if (progressData.status === "completed" && progressData.progress === 100) {
            logger.info(`Operation ${progressData.commandType} completed, waiting for final result`);
          }
        }
        return;
      }
      const myResponse = json.message;
      logger.debug(`Received message: ${JSON.stringify(myResponse)}`);
      logger.log("myResponse" + JSON.stringify(myResponse));
      if (myResponse.id && pendingRequests.has(myResponse.id) && myResponse.result) {
        const request = pendingRequests.get(myResponse.id);
        clearTimeout(request.timeout);
        if (myResponse.error) {
          logger.error(`Error from Figma: ${myResponse.error}`);
          request.reject(new Error(myResponse.error));
        } else {
          if (myResponse.result) {
            request.resolve(myResponse.result);
          }
        }
        pendingRequests.delete(myResponse.id);
      } else {
        logger.info(`Received broadcast message: ${JSON.stringify(myResponse)}`);
      }
    } catch (error) {
      logger.error(`Error parsing message: ${error instanceof Error ? error.message : String(error)}`);
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
    if (!CLI_EXPORT_PNG_MODE) {
      logger.info("Attempting to reconnect in 2 seconds...");
      setTimeout(() => connectToFigma(port), 2e3);
    }
  });
}
function listActiveRelayChannels(timeoutMs = 1e4) {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== import_ws.default.OPEN) {
      connectToFigma();
      reject(new Error("Not connected to Figma relay. Attempting to connect..."));
      return;
    }
    const id = (0, import_uuid.v4)();
    const timeout = setTimeout(() => {
      if (pendingRequests.has(id)) {
        pendingRequests.delete(id);
        reject(new Error("Request to list active channels timed out"));
      }
    }, timeoutMs);
    pendingRequests.set(id, {
      resolve: (value) => {
        resolve(value);
      },
      reject,
      timeout,
      lastActivity: Date.now()
    });
    ws.send(JSON.stringify({ type: "list_channels", id }));
    logger.info("Sent list_channels to relay");
  });
}
async function joinChannel(channelName, channelDescription) {
  if (!ws || ws.readyState !== import_ws.default.OPEN) {
    throw new Error("Not connected to Figma");
  }
  try {
    await sendCommandToFigma("join", {
      channel: channelName,
      channel_description: channelDescription
    });
    currentChannel = channelName;
    currentChannelDescription = channelDescription?.trim() || null;
    logger.info(`Joined channel: ${channelName}`);
  } catch (error) {
    logger.error(`Failed to join channel: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}
function sendCommandToFigma(command, params = {}, timeoutMs = 3e4) {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== import_ws.default.OPEN) {
      connectToFigma();
      reject(new Error("Not connected to Figma. Attempting to connect..."));
      return;
    }
    const requiresChannel = command !== "join";
    if (requiresChannel && !currentChannel) {
      reject(new Error("Must join a channel before sending commands"));
      return;
    }
    const id = (0, import_uuid.v4)();
    const request = {
      id,
      type: command === "join" ? "join" : "message",
      ...command === "join" ? { channel: params.channel } : { channel: currentChannel },
      message: {
        id,
        command,
        params: {
          ...params,
          commandId: id
          // Include the command ID in params
        }
      }
    };
    const timeout = setTimeout(() => {
      if (pendingRequests.has(id)) {
        pendingRequests.delete(id);
        logger.error(`Request ${id} to Figma timed out after ${timeoutMs / 1e3} seconds`);
        reject(new Error("Request to Figma timed out"));
      }
    }, timeoutMs);
    pendingRequests.set(id, {
      resolve,
      reject,
      timeout,
      lastActivity: Date.now()
    });
    logger.info(`Sending command to Figma: ${command}`);
    logger.debug(`Request details: ${JSON.stringify(request)}`);
    ws.send(JSON.stringify(request));
  });
}
figmaTool(
  "get_active_channels",
  "List WebSocket relay channels that currently have at least one connected client. Use after reconnecting or when the channel name is unknown, then call join_channel with a channel name from this list.",
  {},
  async () => {
    try {
      const channels = await listActiveRelayChannels();
      const lines = channels.length === 0 ? "No active channels (no clients connected to the relay, or relay unreachable)." : [
        "Active relay channels (name, connected client count, and optional description):",
        ...channels.map(
          (c) => `  - ${c.name} (${c.clientCount} client(s))${c.description ? ` - ${c.description}` : ""}`
        ),
        "",
        "Call join_channel with one of the names above to pair with Figma on that channel."
      ].join("\n");
      return {
        content: [{ type: "text", text: lines }]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error listing active channels: ${error instanceof Error ? error.message : String(error)}`
          }
        ]
      };
    }
  }
);
figmaTool(
  "join_channel",
  "Join a specific channel to communicate with Figma",
  {
    channel: import_zod.z.string().describe("The channel to join").optional(),
    channel_description: import_zod.z.string().describe("Human-readable context for the channel").optional()
  },
  async ({ channel, channel_description }) => {
    try {
      const normalizedChannel = typeof channel === "string" ? channel.trim() : "";
      const normalizedDescription = typeof channel_description === "string" ? channel_description.trim() : "";
      const resolvedChannel = normalizedChannel || generateRandomChannelName();
      await joinChannel(resolvedChannel, normalizedDescription || void 0);
      const descriptionSuffix = normalizedDescription ? ` (description: ${normalizedDescription})` : "";
      return {
        content: [
          {
            type: "text",
            text: `Successfully joined channel: ${resolvedChannel}${descriptionSuffix}`
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error joining channel: ${error instanceof Error ? error.message : String(error)}`
          }
        ]
      };
    }
  }
);
function generateRandomChannelName(length = 8) {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}
function waitUntilWebSocketOpen(timeoutMs) {
  return new Promise((resolve, reject) => {
    if (ws?.readyState === import_ws.default.OPEN) {
      resolve();
      return;
    }
    if (!ws) {
      reject(new Error("WebSocket not initialized"));
      return;
    }
    const t = setTimeout(() => {
      cleanup();
      reject(new Error(`Timeout (${timeoutMs}ms) waiting for WebSocket connection`));
    }, timeoutMs);
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onErr = (err) => {
      cleanup();
      reject(err);
    };
    function cleanup() {
      clearTimeout(t);
      ws?.off("open", onOpen);
      ws?.off("error", onErr);
    }
    ws.once("open", onOpen);
    ws.once("error", onErr);
  });
}
async function runExportPngCli(opts) {
  connectToFigma(FIGMA_SOCKET_PORT);
  await waitUntilWebSocketOpen(3e4);
  await joinChannel(opts.channel);
  await new Promise((r) => setTimeout(r, 400));
  const result = await sendCommandToFigma(
    "export_node_as_image",
    {
      nodeId: opts.nodeId,
      format: "PNG",
      scale: opts.scale
    },
    45e3
  );
  const b64 = result?.imageData;
  if (!b64 || typeof b64 !== "string") {
    throw new Error("export_node_as_image returned no imageData");
  }
  const abs = resolveWritePathUnderCwd(opts.outRel);
  const buf = Buffer.from(b64, "base64");
  import_node_fs.default.mkdirSync(import_node_path.default.dirname(abs), { recursive: true });
  import_node_fs.default.writeFileSync(abs, buf);
  const rel = import_node_path.default.relative(process.cwd(), abs);
  logger.info(`Wrote ${rel} (${buf.byteLength} bytes)`);
}
async function main() {
  if (EXPORT_PNG_CLI) {
    try {
      await runExportPngCli(EXPORT_PNG_CLI);
      process.exit(0);
    } catch (error) {
      logger.error(
        `export-png CLI failed: ${error instanceof Error ? error.message : String(error)}`
      );
      process.exit(1);
    }
    return;
  }
  try {
    connectToFigma();
  } catch (error) {
    logger.warn(`Could not connect to Figma initially: ${error instanceof Error ? error.message : String(error)}`);
    logger.warn("Will try to connect when the first command is sent");
  }
  const transport = new import_stdio.StdioServerTransport();
  await server.connect(transport);
  logger.info("FigmaMCP server running on stdio");
  if (CLIENT_CONNECTION_MODE === "read-only") {
    logger.info(
      "Connection mode: read-only (mutation tools and write-focused prompts omitted)"
    );
  }
}
main().catch((error) => {
  logger.error(`Error starting FigmaMCP server: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
//# sourceMappingURL=server.cjs.map