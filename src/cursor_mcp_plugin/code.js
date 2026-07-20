// Cursor MCP Figma plugin — read-only Figma API commands (inspect, export, scan)

// Plugin state
const state = {
  serverPort: 3055, // Default port
};


// Helper function for progress updates
async function sendProgressUpdate(
  commandId,
  commandType,
  status,
  progress,
  totalItems,
  processedItems,
  message,
  payload = null
) {
  const update = {
    type: "command_progress",
    commandId,
    commandType,
    status,
    progress,
    totalItems,
    processedItems,
    message,
    timestamp: Date.now(),
  };

  // Add optional chunk information if present
  if (payload) {
    if (
      payload.currentChunk !== undefined &&
      payload.totalChunks !== undefined
    ) {
      update.currentChunk = payload.currentChunk;
      update.totalChunks = payload.totalChunks;
      update.chunkSize = payload.chunkSize;
    }
    update.payload = payload;
  }

  // Send to UI
  figma.ui.postMessage(update);
  console.log(`Progress update: ${status} - ${progress}% - ${message}`);

  // Yield so the Figma plugin sandbox flushes postMessage to ui.html
  // before the next iteration begins
  await new Promise((resolve) => setTimeout(resolve, 0));

  return update;
}

// Show UI (modal on the canvas — not inside the Plugins sidebar).
// Call showUI synchronously so the iframe exists before async init; otherwise messages like
// auto-connect can be dropped. Closing the plugin window still stops the WebSocket — keep this
// panel open while you need MCP; channel/port are persisted so reconnects reuse the same channel.
(function bootstrapPluginUi() {
  const html =
    typeof __html__ !== "undefined" && __html__
      ? __html__
      : '<html><body style="font:14px sans-serif;padding:16px">Cursor MCP: <code>__html__</code> is empty. Re-import the plugin from <code>manifest.json</code> (same folder as <code>ui.html</code>).</body></html>';

  const NORMAL = { width: 350, height: 600 };

  try {
    figma.showUI(html, {
      width: NORMAL.width,
      height: NORMAL.height,
      title: "Talk To Figma MCP",
    });
  } catch (e) {
    try {
      figma.showUI(html, NORMAL);
    } catch (e2) {
      figma.notify(
        "Cursor MCP could not open UI: " + (e2.message || String(e2))
      );
      throw e2;
    }
  }

  (async function sendInitSettings() {
    let saved = {};
    try {
      saved = (await figma.clientStorage.getAsync("settings")) || {};
    } catch (e) {
      console.error("Error loading plugin settings:", e);
    }

    if (saved.serverPort) {
      state.serverPort = saved.serverPort;
    }

    figma.ui.postMessage({
      type: "init-settings",
      settings: {
        serverPort: state.serverPort,
        savedChannel: saved.mcpChannel || null,
        channelDescription: saved.channelDescription || "",
      },
    });

    sendDefaultChannelDescription();
  })();
})();

function sendDefaultChannelDescription() {
  const rootName = figma.root && typeof figma.root.name === "string"
    ? figma.root.name
    : "";
  const fileName = rootName.trim();
  if (!fileName) return;
  figma.ui.postMessage({
    type: "default-channel-description",
    description: fileName,
  });
}

// Plugin commands from UI
figma.ui.onmessage = async (msg) => {
  switch (msg.type) {
    case "update-settings":
      updateSettings(msg);
      break;
    case "notify":
      figma.notify(msg.message);
      break;
    case "close-plugin":
      figma.closePlugin();
      break;
    case "persist-connection":
      (async () => {
        try {
          const cur = (await figma.clientStorage.getAsync("settings")) || {};
          await figma.clientStorage.setAsync(
            "settings",
            Object.assign({}, cur, {
              serverPort:
                msg.serverPort != null
                  ? msg.serverPort
                  : cur.serverPort != null
                    ? cur.serverPort
                    : state.serverPort,
              mcpChannel:
                msg.channel != null ? msg.channel : cur.mcpChannel,
              channelDescription:
                msg.channelDescription != null
                  ? msg.channelDescription
                  : cur.channelDescription != null
                    ? cur.channelDescription
                    : "",
            })
          );
        } catch (e) {
          console.error("persist-connection:", e);
        }
      })();
      break;
    case "execute-command":
      // Execute commands received from UI (which gets them from WebSocket)
      try {
        const result = await handleCommand(msg.command, msg.params);
        // Send result back to UI
        figma.ui.postMessage({
          type: "command-result",
          id: msg.id,
          result,
        });
      } catch (error) {
        figma.ui.postMessage({
          type: "command-error",
          id: msg.id,
          error: error.message || "Error executing command",
        });
      }
      break;
  }
};

// Listen for plugin commands from menu
figma.on("run", ({ command }) => {
  sendDefaultChannelDescription();
  figma.ui.postMessage({ type: "auto-connect" });
});

// Update plugin settings
function updateSettings(settings) {
  if (settings.serverPort) {
    state.serverPort = settings.serverPort;
  }

  figma.clientStorage.setAsync("settings", {
    serverPort: state.serverPort,
  });
}

// Handle commands from UI
async function handleCommand(command, params) {
  switch (command) {
    case "get_document_info":
      return await getDocumentInfo();
    case "list_pages":
      return await listPages();
    case "get_page_layers":
      if (!params || !params.pageId) {
        throw new Error("Missing pageId parameter");
      }
      return await getPageLayers(params);
    case "get_selection":
      return await getSelection();
    case "get_node_info":
      if (!params || !params.nodeId) {
        throw new Error("Missing nodeId parameter");
      }
      return await getNodeInfo(params.nodeId);
    case "get_nodes_info":
      if (!params || !params.nodeIds || !Array.isArray(params.nodeIds)) {
        throw new Error("Missing or invalid nodeIds parameter");
      }
      return await getNodesInfo(params.nodeIds);
    case "get_asset":
      if (!params || !params.nodeIds || !Array.isArray(params.nodeIds)) {
        throw new Error("Missing or invalid nodeIds parameter");
      }
      return await getAsset(params.nodeIds);
    case "read_my_design":
      return await readMyDesign();
    case "get_styles":
      return await getStyles();
    case "get_local_components":
      return await getLocalComponents(params);
    case "export_node_as_image":
      return await exportNodeAsImage(params);
    case "export_node_as_svg":
      return await exportNodeAsSvg(params);
    case "scan_text_nodes":
      return await scanTextNodes(params);
    case "get_annotations":
      return await getAnnotations(params);
    case "scan_nodes_by_types":
      return await scanNodesByTypes(params);
    case "get_instance_overrides":
      if (params && params.instanceNodeId) {
        const instanceNode = await figma.getNodeByIdAsync(params.instanceNodeId);
        if (!instanceNode) {
          throw new Error(`Instance node not found with ID: ${params.instanceNodeId}`);
        }
        return await getInstanceOverrides(instanceNode);
      }
      return await getInstanceOverrides();
    case "set_focus":
      return await setFocus(params);
    case "set_selections":
      return await setSelections(params);
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

// Command implementations

async function getDocumentInfo() {
  await figma.currentPage.loadAsync();
  const page = figma.currentPage;
  return {
    name: page.name,
    id: page.id,
    type: page.type,
    children: page.children.map((node) => ({
      id: node.id,
      name: node.name,
      type: node.type,
    })),
    currentPage: {
      id: page.id,
      name: page.name,
      childCount: page.children.length,
    },
    pages: [
      {
        id: page.id,
        name: page.name,
        childCount: page.children.length,
      },
    ],
  };
}

async function listPages() {
  // loadAllPagesAsync is required before reading figma.root.children in
  // documents with dynamic-page loading enabled (see manifest.json).
  await figma.loadAllPagesAsync();
  return {
    pages: figma.root.children.map((page) => ({
      id: page.id,
      name: page.name,
      childCount: page.children.length,
    })),
    count: figma.root.children.length,
  };
}

const GET_PAGE_LAYERS_MAX_LAYERS = 5000;

// Select a page and flatten all (or filtered) layers inside it
async function getPageLayers(params) {
  const { pageId, types, maxDepth } = params || {};

  const page = await figma.getNodeByIdAsync(pageId);
  if (!page || page.type !== "PAGE") {
    throw new Error(`Page not found with ID: ${pageId}`);
  }

  // Page contents must be loaded before traversal/selection in
  // dynamic-page documents (see manifest.json).
  await page.loadAsync();
  await figma.setCurrentPageAsync(page);

  const typeFilter = Array.isArray(types) && types.length > 0 ? types : null;
  const layers = [];
  let truncated = false;

  function walk(node, depth) {
    if (truncated || node.visible === false) return;

    if (!typeFilter || typeFilter.includes(node.type)) {
      if (layers.length >= GET_PAGE_LAYERS_MAX_LAYERS) {
        truncated = true;
        return;
      }
      layers.push({
        id: node.id,
        name: node.name || `Unnamed ${node.type}`,
        type: node.type,
        depth,
      });
    }

    if ("children" in node && (maxDepth == null || depth < maxDepth)) {
      for (const child of node.children) {
        walk(child, depth + 1);
        if (truncated) break;
      }
    }
  }

  for (const child of page.children) {
    walk(child, 0);
    if (truncated) break;
  }

  return {
    pageId: page.id,
    pageName: page.name,
    count: layers.length,
    truncated,
    layers,
  };
}

async function getSelection() {
  return {
    selectionCount: figma.currentPage.selection.length,
    selection: figma.currentPage.selection.map((node) => ({
      id: node.id,
      name: node.name,
      type: node.type,
      visible: node.visible,
    })),
  };
}

function rgbaToHex(color) {
  var r = Math.round(color.r * 255);
  var g = Math.round(color.g * 255);
  var b = Math.round(color.b * 255);
  var a = color.a !== undefined ? Math.round(color.a * 255) : 255;

  if (a === 255) {
    return (
      "#" +
      [r, g, b]
        .map((x) => {
          return x.toString(16).padStart(2, "0");
        })
        .join("")
    );
  }

  return (
    "#" +
    [r, g, b, a]
      .map((x) => {
        return x.toString(16).padStart(2, "0");
      })
      .join("")
  );
}

function filterFigmaNode(node) {
  if (node.absoluteRenderBounds === null || node.opacity === 0) {
    return null;
  }

  var filtered = {
    id: node.id,
    name: node.name,
    type: node.type,
    opacity: node.opacity,
    cornerRadius: node.cornerRadius,
    absoluteBoundingBox: node.absoluteBoundingBox,
    absoluteRenderBounds: node.absoluteRenderBounds,
    characters: node.characters,
    style: node.style,
  };

  if (node.paddingLeft) filtered.paddingLeft = node.paddingLeft
  if (node.paddingRight) filtered.paddingRight = node.paddingRight
  if (node.paddingTop) filtered.paddingTop = node.paddingTop
  if (node.paddingBottom) filtered.paddingBottom = node.paddingBottom
  if (node.effects) filtered.effects = node.effects
  if (node.layoutAlign) filtered.layoutAlign = node.layoutAlign
  if (node.layoutGrow) filtered.layoutGrow = node.layoutGrow
  if (node.layoutMode) filtered.layoutMode = node.layoutMode
  if (node.layoutPositioning) filtered.layoutPositioning = node.layoutPositioning
  if (node.layoutSizingHorizontal) filtered.layoutSizingHorizontal = node.layoutSizingHorizontal
  if (node.layoutSizingVertical) filtered.layoutSizingVertical = node.layoutSizingVertical
  if (node.layoutWrap) filtered.layoutWrap = node.layoutWrap
  if (node.fills && node.fills.length > 0) filtered.fills = node.fills
  if (node.strokes && node.strokes.length > 0) filtered.strokes = node.strokes
  if ("clipsContent" in node) filtered.clipsContent = node.clipsContent
  if (node.blendMode) filtered.blendMode = node.blendMode
  if (node.constraints) filtered.constraints = node.constraints
  if (node.rectangleCornerRadii) filtered.rectangleCornerRadii = node.rectangleCornerRadii

  if (node.children) {
    filtered.children = node.children
      .map((child) => {
        return filterFigmaNode(child);
      })
      .filter((child) => {
        return child !== null;
      });
  }

  return filtered;
}

const ASSET_PREDICTION_THRESHOLD = 50;

const VECTOR_PRIMITIVE_TYPES = [
  "VECTOR",
  "BOOLEAN_OPERATION",
  "REGULAR_POLYGON",
  "POLYGON",
  "ELLIPSE",
  "STAR",
  "LINE",
];

/** Visible IMAGE fills (incl. animated GIF via gifRef). */
function getImageFillInfo(node) {
  const fills = node.fills;
  if (!fills || !Array.isArray(fills) || fills.length === 0) {
    return { hasImageFill: false, hasGifFill: false };
  }
  let hasImageFill = false;
  let hasGifFill = false;
  for (const fill of fills) {
    if (!fill || fill.visible === false || fill.type !== "IMAGE") {
      continue;
    }
    hasImageFill = true;
    if (fill.gifRef) {
      hasGifFill = true;
    }
  }
  return { hasImageFill, hasGifFill };
}

function predictIconConfidence(node) {
  let score = 0;

  let totalNodes = 0;
  let vectorNodes = 0;
  let hasTextOrLayout = false;

  function analyzeStructure(n) {
    totalNodes++;
    if (VECTOR_PRIMITIVE_TYPES.includes(n.type)) {
      vectorNodes++;
    }
    if ((n.layoutMode && n.layoutMode !== "NONE") || n.type === "TEXT") {
      hasTextOrLayout = true;
    }
    if (n.children) n.children.forEach(analyzeStructure);
  }
  analyzeStructure(node);

  if (!hasTextOrLayout) {
    score += 20;
  }
  if (totalNodes > 0 && vectorNodes / totalNodes >= 0.75) {
    score += 20;
  }

  const bounds = node.absoluteBoundingBox;
  const imageFill = getImageFillInfo(node);
  if (imageFill.hasImageFill) {
    score += 30;
    if (imageFill.hasGifFill) {
      score += 10;
    }
  }

  if (bounds) {
    const isSquare = Math.abs(bounds.width - bounds.height) < 0.01;
    const isStandardIconSize = bounds.width >= 12 && bounds.width <= 48;
    const isRasterAssetSize =
      bounds.width >= 24 && bounds.width <= 512 && bounds.height <= 512;

    if (isSquare) score += 15;
    if (isStandardIconSize) score += 15;
    if (imageFill.hasImageFill && isRasterAssetSize) {
      score += 10;
    }
  }

  let totalConstraints = 0;
  let scaleConstraints = 0;

  function checkConstraints(n) {
    if (n.constraints) {
      totalConstraints++;
      if (
        n.constraints.horizontal === "SCALE" &&
        n.constraints.vertical === "SCALE"
      ) {
        scaleConstraints++;
      }
    }
    if (n.children) n.children.forEach(checkConstraints);
  }
  checkConstraints(node);

  if (totalConstraints > 0 && scaleConstraints / totalConstraints >= 0.5) {
    score += 20;
  }

  if (node.name) {
    const name = node.name.toLowerCase();
    const hasIconKeywords =
      name.includes("icon") ||
      name.includes("outline") ||
      name.includes("linear");
    const isKebabCase = /^[a-z0-9]+(-[a-z0-9]+)*$/.test(node.name);

    if (hasIconKeywords || isKebabCase) {
      score += 10;
    }
  }

  return Math.min(100, Math.max(0, score));
}

function withAssetPrediction(filteredNode, rawNode) {
  const assetPrediction = predictIconConfidence(rawNode);
  if (!filteredNode) {
    return {
      assetPrediction,
      isAsset: assetPrediction >= ASSET_PREDICTION_THRESHOLD,
    };
  }
  return Object.assign({}, filteredNode, {
    assetPrediction,
    isAsset: assetPrediction >= ASSET_PREDICTION_THRESHOLD,
  });
}

function withAssetPredictionTree(filteredNode, rawNode) {
  if (!filteredNode) {
    return withAssetPrediction(null, rawNode);
  }
  const result = withAssetPrediction(filteredNode, rawNode);
  if (filteredNode.children && filteredNode.children.length > 0) {
    const rawChildren = rawNode.children || [];
    const rawById = new Map(rawChildren.map((child) => [child.id, child]));
    result.children = filteredNode.children.map((filteredChild) => {
      const rawChild = rawById.get(filteredChild.id);
      return withAssetPredictionTree(
        filteredChild,
        rawChild || filteredChild
      );
    });
  }
  return result;
}

/** Deepest isAsset leaves; prefer nearest INSTANCE on the path, else vector-primitive parent. */
function exportIdForAssetPath(path) {
  for (let i = path.length - 1; i >= 0; i--) {
    const n = path[i];
    if (n.type === "INSTANCE" && n.isAsset) {
      return n.id;
    }
  }
  const node = path[path.length - 1];
  const parent = path.length >= 2 ? path[path.length - 2] : null;
  if (
    VECTOR_PRIMITIVE_TYPES.includes(node.type) &&
    parent &&
    parent.isAsset
  ) {
    return parent.id;
  }
  return node.id;
}

function resolveExportTargetIds(root) {
  const assets = [];

  function walk(node, depth, path) {
    const currentPath = [...path, node];
    if (node.isAsset) {
      assets.push({ node, depth, path: currentPath });
    }
    if (node.children) {
      for (const child of node.children) {
        walk(child, depth + 1, currentPath);
      }
    }
  }

  walk(root, 0, []);
  if (assets.length === 0) {
    return [];
  }

  const maxDepth = Math.max(...assets.map((a) => a.depth));
  const atMaxDepth = assets.filter((a) => a.depth === maxDepth);
  const ids = new Set();

  for (const { path } of atMaxDepth) {
    ids.add(exportIdForAssetPath(path));
  }

  return [...ids];
}

function applyExportTargets(node, exportIds) {
  const result = Object.assign({}, node, {
    exportTarget: exportIds.has(node.id),
  });
  if (node.children) {
    result.children = node.children.map((child) =>
      applyExportTargets(child, exportIds)
    );
  }
  return result;
}

async function getAsset(nodeIds) {
  try {
    const nodes = await Promise.all(
      nodeIds.map((id) => figma.getNodeByIdAsync(id))
    );

    const responses = await Promise.all(
      nodeIds.map(async (requestedId, index) => {
        const node = nodes[index];
        if (!node) {
          return {
            nodeId: requestedId,
            document: null,
            error: `Node not found with ID: ${requestedId}`,
          };
        }

        const response = await node.exportAsync({
          format: "JSON_REST_V1",
        });
        const rawDocument = response.document;
        const filtered = filterFigmaNode(rawDocument);
        const withPrediction = withAssetPredictionTree(filtered, rawDocument);
        const exportNodeIds = resolveExportTargetIds(withPrediction);
        const document = applyExportTargets(withPrediction, new Set(exportNodeIds));

        return {
          nodeId: node.id,
          document,
          exportNodeIds,
        };
      })
    );

    return responses;
  } catch (error) {
    throw new Error(`Error getting asset predictions: ${error.message}`);
  }
}

async function getNodeInfo(nodeId) {
  const node = await figma.getNodeByIdAsync(nodeId);

  if (!node) {
    throw new Error(`Node not found with ID: ${nodeId}`);
  }

  const response = await node.exportAsync({
    format: "JSON_REST_V1",
  });

  return filterFigmaNode(response.document);
}

async function getNodesInfo(nodeIds) {
  try {
    // Load all nodes in parallel
    const nodes = await Promise.all(
      nodeIds.map((id) => figma.getNodeByIdAsync(id))
    );

    // Filter out any null values (nodes that weren't found)
    const validNodes = nodes.filter((node) => node !== null);

    // Export all valid nodes in parallel
    const responses = await Promise.all(
      validNodes.map(async (node) => {
        const response = await node.exportAsync({
          format: "JSON_REST_V1",
        });
        var document = filterFigmaNode(response.document);
        return {
          nodeId: node.id,
          document: document,
        };
      })
    );

    return responses;
  } catch (error) {
    throw new Error(`Error getting nodes info: ${error.message}`);
  }
}

async function readMyDesign() {
  try {
    // Load all selected nodes in parallel
    const nodes = await Promise.all(
      figma.currentPage.selection.map((node) => figma.getNodeByIdAsync(node.id))
    );

    // Filter out any null values (nodes that weren't found)
    const validNodes = nodes.filter((node) => node !== null);

    // Export all valid nodes in parallel
    const responses = await Promise.all(
      validNodes.map(async (node) => {
        const response = await node.exportAsync({
          format: "JSON_REST_V1",
        });
        return {
          nodeId: node.id,
          document: filterFigmaNode(response.document),
        };
      })
    );

    return responses;
  } catch (error) {
    throw new Error(`Error getting nodes info: ${error.message}`);
  }
}

async function getStyles() {
  const styles = {
    colors: await figma.getLocalPaintStylesAsync(),
    texts: await figma.getLocalTextStylesAsync(),
    effects: await figma.getLocalEffectStylesAsync(),
    grids: await figma.getLocalGridStylesAsync(),
  };

  return {
    colors: styles.colors.map((style) => ({
      id: style.id,
      name: style.name,
      key: style.key,
      paint: style.paints[0],
    })),
    texts: styles.texts.map((style) => ({
      id: style.id,
      name: style.name,
      key: style.key,
      fontSize: style.fontSize,
      fontName: style.fontName,
    })),
    effects: styles.effects.map((style) => ({
      id: style.id,
      name: style.name,
      key: style.key,
    })),
    grids: styles.grids.map((style) => ({
      id: style.id,
      name: style.name,
      key: style.key,
    })),
  };
}

async function getLocalComponents(params) {
  const commandId = (params && params.commandId) || generateCommandId();
  const pages = figma.root.children;
  const totalPages = pages.length;

  await sendProgressUpdate(
    commandId,
    "get_local_components",
    "started",
    0,
    totalPages,
    0,
    "Starting component scan across " + totalPages + " pages...",
    null
  );

  var allComponents = [];

  for (var i = 0; i < totalPages; i++) {
    var page = pages[i];
    await page.loadAsync();

    var pageComponents = page.findAllWithCriteria({ types: ["COMPONENT"] });

    for (var j = 0; j < pageComponents.length; j++) {
      var component = pageComponents[j];
      allComponents.push({
        id: component.id,
        name: component.name,
        key: "key" in component ? component.key : null,
      });
    }

    var progress = Math.round(((i + 1) / totalPages) * 100);
    await sendProgressUpdate(
      commandId,
      "get_local_components",
      "in_progress",
      progress,
      totalPages,
      i + 1,
      "Scanned " + page.name + ": " + pageComponents.length + " components (total so far: " + allComponents.length + ")",
      null
    );
  }

  await sendProgressUpdate(
    commandId,
    "get_local_components",
    "completed",
    100,
    totalPages,
    totalPages,
    "Found " + allComponents.length + " components across " + totalPages + " pages",
    null
  );

  return {
    count: allComponents.length,
    components: allComponents,
  };
}

function utf8EncodeString(str) {
  const bytes = [];
  for (let i = 0; i < str.length; i++) {
    let code = str.charCodeAt(i);
    if (code < 0x80) {
      bytes.push(code);
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < str.length) {
      const next = str.charCodeAt(++i);
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
        bytes.push(
          0xf0 | (code >> 18),
          0x80 | ((code >> 12) & 0x3f),
          0x80 | ((code >> 6) & 0x3f),
          0x80 | (code & 0x3f)
        );
      } else {
        bytes.push(
          0xe0 | (code >> 12),
          0x80 | ((code >> 6) & 0x3f),
          0x80 | (code & 0x3f)
        );
      }
    } else {
      bytes.push(
        0xe0 | (code >> 12),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f)
      );
    }
  }
  return new Uint8Array(bytes);
}

async function exportNodeAsSvg(params) {
  const nodeId = params && params.nodeId;
  if (!nodeId) {
    throw new Error("Missing nodeId parameter");
  }

  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) {
    throw new Error(`Node not found with ID: ${nodeId}`);
  }

  if (!("exportAsync" in node)) {
    throw new Error(`Node does not support exporting: ${nodeId}`);
  }

  try {
    const svg = await node.exportAsync({ format: "SVG_STRING" });
    if (typeof svg !== "string" || !svg.trimStart().startsWith("<")) {
      throw new Error("SVG_STRING export did not return valid SVG markup");
    }

    return {
      nodeId,
      format: "SVG_STRING",
      mimeType: "image/svg+xml",
      svg,
      imageData: customBase64Encode(utf8EncodeString(svg)),
    };
  } catch (error) {
    throw new Error(`Error exporting node as SVG: ${error.message}`);
  }
}

async function exportNodeAsImage(params) {
  const { nodeId, scale = 1 } = params || {};

  if (!nodeId) {
    throw new Error("Missing nodeId parameter");
  }

  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) {
    throw new Error(`Node not found with ID: ${nodeId}`);
  }

  if (!("exportAsync" in node)) {
    throw new Error(`Node does not support exporting: ${nodeId}`);
  }

  try {
    const bytes = await node.exportAsync({
      format: "PNG",
      constraint: { type: "SCALE", value: scale },
    });

    return {
      nodeId,
      format: "PNG",
      scale,
      mimeType: "image/png",
      imageData: customBase64Encode(bytes),
    };
  } catch (error) {
    throw new Error(`Error exporting node as PNG: ${error.message}`);
  }
}
function customBase64Encode(bytes) {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let base64 = "";

  const byteLength = bytes.byteLength;
  const byteRemainder = byteLength % 3;
  const mainLength = byteLength - byteRemainder;

  let a, b, c, d;
  let chunk;

  // Main loop deals with bytes in chunks of 3
  for (let i = 0; i < mainLength; i = i + 3) {
    // Combine the three bytes into a single integer
    chunk = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];

    // Use bitmasks to extract 6-bit segments from the triplet
    a = (chunk & 16515072) >> 18; // 16515072 = (2^6 - 1) << 18
    b = (chunk & 258048) >> 12; // 258048 = (2^6 - 1) << 12
    c = (chunk & 4032) >> 6; // 4032 = (2^6 - 1) << 6
    d = chunk & 63; // 63 = 2^6 - 1

    // Convert the raw binary segments to the appropriate ASCII encoding
    base64 += chars[a] + chars[b] + chars[c] + chars[d];
  }

  // Deal with the remaining bytes and padding
  if (byteRemainder === 1) {
    chunk = bytes[mainLength];

    a = (chunk & 252) >> 2; // 252 = (2^6 - 1) << 2

    // Set the 4 least significant bits to zero
    b = (chunk & 3) << 4; // 3 = 2^2 - 1

    base64 += chars[a] + chars[b] + "==";
  } else if (byteRemainder === 2) {
    chunk = (bytes[mainLength] << 8) | bytes[mainLength + 1];

    a = (chunk & 64512) >> 10; // 64512 = (2^6 - 1) << 10
    b = (chunk & 1008) >> 4; // 1008 = (2^6 - 1) << 4

    // Set the 2 least significant bits to zero
    c = (chunk & 15) << 2; // 15 = 2^4 - 1

    base64 += chars[a] + chars[b] + chars[c] + "=";
  }

  return base64;
}

async function scanTextNodes(params) {
  console.log(`Starting to scan text nodes from node ID: ${params.nodeId}`);
  const {
    nodeId,
    chunkSize = 10,
    commandId = generateCommandId(),
  } = params || {};

  const node = await figma.getNodeByIdAsync(nodeId);

  if (!node) {
    console.error(`Node with ID ${nodeId} not found`);
    // Send error progress update
    sendProgressUpdate(
      commandId,
      "scan_text_nodes",
      "error",
      0,
      0,
      0,
      `Node with ID ${nodeId} not found`,
      { error: `Node not found: ${nodeId}` }
    );
    throw new Error(`Node with ID ${nodeId} not found`);
  }

  console.log(`Scanning text nodes with chunk size: ${chunkSize}`);

  // First, collect all nodes to process (without processing them yet)
  const nodesToProcess = [];

  // Send started progress update
  sendProgressUpdate(
    commandId,
    "scan_text_nodes",
    "started",
    0,
    0, // Not known yet how many nodes there are
    0,
    `Starting chunked scan of node "${node.name || nodeId}"`,
    { chunkSize }
  );

  await collectNodesToProcess(node, [], 0, nodesToProcess);

  const totalNodes = nodesToProcess.length;
  console.log(`Found ${totalNodes} total nodes to process`);

  // Calculate number of chunks needed
  const totalChunks = Math.ceil(totalNodes / chunkSize);
  console.log(`Will process in ${totalChunks} chunks`);

  // Send update after node collection
  sendProgressUpdate(
    commandId,
    "scan_text_nodes",
    "in_progress",
    5, // 5% progress for collection phase
    totalNodes,
    0,
    `Found ${totalNodes} nodes to scan. Will process in ${totalChunks} chunks.`,
    {
      totalNodes,
      totalChunks,
      chunkSize,
    }
  );

  // Process nodes in chunks
  const allTextNodes = [];
  let processedNodes = 0;
  let chunksProcessed = 0;

  for (let i = 0; i < totalNodes; i += chunkSize) {
    const chunkEnd = Math.min(i + chunkSize, totalNodes);
    console.log(
      `Processing chunk ${chunksProcessed + 1}/${totalChunks} (nodes ${i} to ${chunkEnd - 1
      })`
    );

    // Send update before processing chunk
    sendProgressUpdate(
      commandId,
      "scan_text_nodes",
      "in_progress",
      Math.round(5 + (chunksProcessed / totalChunks) * 90), // 5-95% for processing
      totalNodes,
      processedNodes,
      `Processing chunk ${chunksProcessed + 1}/${totalChunks}`,
      {
        currentChunk: chunksProcessed + 1,
        totalChunks,
        textNodesFound: allTextNodes.length,
      }
    );

    const chunkNodes = nodesToProcess.slice(i, chunkEnd);
    const chunkTextNodes = [];

    // Process each node in this chunk
    for (const nodeInfo of chunkNodes) {
      if (nodeInfo.node.type === "TEXT") {
        try {
          const textNodeInfo = await processTextNode(
            nodeInfo.node,
            nodeInfo.parentPath,
            nodeInfo.depth
          );
          if (textNodeInfo) {
            chunkTextNodes.push(textNodeInfo);
          }
        } catch (error) {
          console.error(`Error processing text node: ${error.message}`);
          // Continue with other nodes
        }
      }

      // Brief delay to allow UI updates and prevent freezing
      await delay(5);
    }

    // Add results from this chunk
    allTextNodes.push(...chunkTextNodes);
    processedNodes += chunkNodes.length;
    chunksProcessed++;

    // Send update after processing chunk
    sendProgressUpdate(
      commandId,
      "scan_text_nodes",
      "in_progress",
      Math.round(5 + (chunksProcessed / totalChunks) * 90), // 5-95% for processing
      totalNodes,
      processedNodes,
      `Processed chunk ${chunksProcessed}/${totalChunks}. Found ${allTextNodes.length} text nodes so far.`,
      {
        currentChunk: chunksProcessed,
        totalChunks,
        processedNodes,
        textNodesFound: allTextNodes.length,
        chunkResult: chunkTextNodes,
      }
    );

    // Small delay between chunks to prevent UI freezing
    if (i + chunkSize < totalNodes) {
      await delay(50);
    }
  }

  // Send completed progress update
  sendProgressUpdate(
    commandId,
    "scan_text_nodes",
    "completed",
    100,
    totalNodes,
    processedNodes,
    `Scan complete. Found ${allTextNodes.length} text nodes.`,
    {
      textNodes: allTextNodes,
      processedNodes,
      chunks: chunksProcessed,
    }
  );

  return {
    success: true,
    message: `Chunked scan complete. Found ${allTextNodes.length} text nodes.`,
    totalNodes: allTextNodes.length,
    processedNodes: processedNodes,
    chunks: chunksProcessed,
    textNodes: allTextNodes,
    commandId,
  };
}

// Helper function to collect all nodes that need to be processed
async function collectNodesToProcess(
  node,
  parentPath = [],
  depth = 0,
  nodesToProcess = []
) {
  // Skip invisible nodes
  if (node.visible === false) return;

  // Get the path to this node
  const nodePath = [...parentPath, node.name || `Unnamed ${node.type}`];

  // Add this node to the processing list
  nodesToProcess.push({
    node: node,
    parentPath: nodePath,
    depth: depth,
  });

  // Recursively add children
  if ("children" in node) {
    for (const child of node.children) {
      await collectNodesToProcess(child, nodePath, depth + 1, nodesToProcess);
    }
  }
}

// Process a single text node
async function processTextNode(node, parentPath, depth) {
  if (node.type !== "TEXT") return null;

  try {
    // Safely extract font information
    let fontFamily = "";
    let fontStyle = "";

    if (node.fontName) {
      if (typeof node.fontName === "object") {
        if ("family" in node.fontName) fontFamily = node.fontName.family;
        if ("style" in node.fontName) fontStyle = node.fontName.style;
      }
    }

    // Create a safe representation of the text node
    const safeTextNode = {
      id: node.id,
      name: node.name || "Text",
      type: node.type,
      characters: node.characters,
      fontSize: typeof node.fontSize === "number" ? node.fontSize : 0,
      fontFamily: fontFamily,
      fontStyle: fontStyle,
      x: typeof node.x === "number" ? node.x : 0,
      y: typeof node.y === "number" ? node.y : 0,
      width: typeof node.width === "number" ? node.width : 0,
      height: typeof node.height === "number" ? node.height : 0,
      path: parentPath.join(" > "),
      depth: depth,
    };

    // Highlight the node briefly (optional visual feedback)
    try {
      const originalFills = JSON.parse(JSON.stringify(node.fills));
      node.fills = [
        {
          type: "SOLID",
          color: { r: 1, g: 0.5, b: 0 },
          opacity: 0.3,
        },
      ];

      // Brief delay for the highlight to be visible
      await delay(100);

      try {
        node.fills = originalFills;
      } catch (err) {
        console.error("Error resetting fills:", err);
      }
    } catch (highlightErr) {
      console.error("Error highlighting text node:", highlightErr);
      // Continue anyway, highlighting is just visual feedback
    }

    return safeTextNode;
  } catch (nodeErr) {
    console.error("Error processing text node:", nodeErr);
    return null;
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function generateCommandId() {
  return (
    "cmd_" +
    Math.random().toString(36).substring(2, 15) +
    Math.random().toString(36).substring(2, 15)
  );
}

async function getAnnotations(params) {
  try {
    const { nodeId, includeCategories = true } = params;

    // Get categories first if needed
    let categoriesMap = {};
    if (includeCategories) {
      const categories = await figma.annotations.getAnnotationCategoriesAsync();
      categoriesMap = categories.reduce((map, category) => {
        map[category.id] = {
          id: category.id,
          label: category.label,
          color: category.color,
          isPreset: category.isPreset,
        };
        return map;
      }, {});
    }

    if (nodeId) {
      // Get annotations for a specific node
      const node = await figma.getNodeByIdAsync(nodeId);
      if (!node) {
        throw new Error(`Node not found: ${nodeId}`);
      }

      if (!("annotations" in node)) {
        throw new Error(`Node type ${node.type} does not support annotations`);
      }

      // Collect annotations from this node and all its descendants
      const mergedAnnotations = [];
      const collect = async (n) => {
        if ("annotations" in n && n.annotations && n.annotations.length > 0) {
          for (const a of n.annotations) {
            mergedAnnotations.push({ nodeId: n.id, annotation: a });
          }
        }
        if ("children" in n) {
          for (const child of n.children) {
            await collect(child);
          }
        }
      };
      await collect(node);

      const result = {
        nodeId: node.id,
        name: node.name,
        annotations: mergedAnnotations,
      };

      if (includeCategories) {
        result.categories = Object.values(categoriesMap);
      }

      return result;
    } else {
      // Get all annotations in the current page
      const annotations = [];
      const processNode = async (node) => {
        if (
          "annotations" in node &&
          node.annotations &&
          node.annotations.length > 0
        ) {
          annotations.push({
            nodeId: node.id,
            name: node.name,
            annotations: node.annotations,
          });
        }
        if ("children" in node) {
          for (const child of node.children) {
            await processNode(child);
          }
        }
      };

      // Start from current page
      await processNode(figma.currentPage);

      const result = {
        annotatedNodes: annotations,
      };

      if (includeCategories) {
        result.categories = Object.values(categoriesMap);
      }

      return result;
    }
  } catch (error) {
    console.error("Error in getAnnotations:", error);
    throw error;
  }
}

/**
 * Scan for nodes with specific types within a node
 * @param {Object} params - Parameters object
 * @param {string} params.nodeId - ID of the node to scan within
 * @param {Array<string>} params.types - Array of node types to find (e.g. ['COMPONENT', 'FRAME'])
 * @returns {Object} - Object containing found nodes
 */
async function scanNodesByTypes(params) {
  console.log(`Starting to scan nodes by types from node ID: ${params.nodeId}`);
  const { nodeId, types = [] } = params || {};

  if (!types || types.length === 0) {
    throw new Error("No types specified to search for");
  }

  const node = await figma.getNodeByIdAsync(nodeId);

  if (!node) {
    throw new Error(`Node with ID ${nodeId} not found`);
  }

  // Simple implementation without chunking
  const matchingNodes = [];

  // Send a single progress update to notify start
  const commandId = generateCommandId();
  sendProgressUpdate(
    commandId,
    "scan_nodes_by_types",
    "started",
    0,
    1,
    0,
    `Starting scan of node "${node.name || nodeId}" for types: ${types.join(
      ", "
    )}`,
    null
  );

  // Recursively find nodes with specified types
  await findNodesByTypes(node, types, matchingNodes);

  // Send completion update
  sendProgressUpdate(
    commandId,
    "scan_nodes_by_types",
    "completed",
    100,
    matchingNodes.length,
    matchingNodes.length,
    `Scan complete. Found ${matchingNodes.length} matching nodes.`,
    { matchingNodes }
  );

  return {
    success: true,
    message: `Found ${matchingNodes.length} matching nodes.`,
    count: matchingNodes.length,
    matchingNodes: matchingNodes,
    searchedTypes: types,
  };
}

/**
 * Helper function to recursively find nodes with specific types
 * @param {SceneNode} node - The root node to start searching from
 * @param {Array<string>} types - Array of node types to find
 * @param {Array} matchingNodes - Array to store found nodes
 */
async function findNodesByTypes(node, types, matchingNodes = []) {
  // Skip invisible nodes
  if (node.visible === false) return;

  // Check if this node is one of the specified types
  if (types.includes(node.type)) {
    // Create a minimal representation with just ID, type and bbox
    matchingNodes.push({
      id: node.id,
      name: node.name || `Unnamed ${node.type}`,
      type: node.type,
      // Basic bounding box info
      bbox: {
        x: typeof node.x === "number" ? node.x : 0,
        y: typeof node.y === "number" ? node.y : 0,
        width: typeof node.width === "number" ? node.width : 0,
        height: typeof node.height === "number" ? node.height : 0,
      },
    });
  }

  // Recursively process children of container nodes
  if ("children" in node) {
    for (const child of node.children) {
      await findNodesByTypes(child, types, matchingNodes);
    }
  }
}

// Set multiple annotations with async progress updates
// Implementation for getInstanceOverrides function
async function getInstanceOverrides(instanceNode = null) {
  console.log("=== getInstanceOverrides called ===");

  let sourceInstance = null;

  // Check if an instance node was passed directly
  if (instanceNode) {
    console.log("Using provided instance node");

    // Validate that the provided node is an instance
    if (instanceNode.type !== "INSTANCE") {
      console.error("Provided node is not an instance");
      figma.notify("Provided node is not a component instance");
      return { success: false, message: "Provided node is not a component instance" };
    }

    sourceInstance = instanceNode;
  } else {
    // No node provided, use selection
    console.log("No node provided, using current selection");

    // Get the current selection
    const selection = figma.currentPage.selection;

    // Check if there's anything selected
    if (selection.length === 0) {
      console.log("No nodes selected");
      figma.notify("Please select at least one instance");
      return { success: false, message: "No nodes selected" };
    }

    // Filter for instances in the selection
    const instances = selection.filter(node => node.type === "INSTANCE");

    if (instances.length === 0) {
      console.log("No instances found in selection");
      figma.notify("Please select at least one component instance");
      return { success: false, message: "No instances found in selection" };
    }

    // Take the first instance from the selection
    sourceInstance = instances[0];
  }

  try {
    console.log(`Getting instance information:`);
    console.log(sourceInstance);

    // Get component overrides and main component
    const overrides = sourceInstance.overrides || [];
    console.log(`  Raw Overrides:`, overrides);

    // Get main component
    const mainComponent = await sourceInstance.getMainComponentAsync();
    if (!mainComponent) {
      console.error("Failed to get main component");
      figma.notify("Failed to get main component");
      return { success: false, message: "Failed to get main component" };
    }

    // return data to MCP server
    const returnData = {
      success: true,
      message: `Got component information from "${sourceInstance.name}" for overrides.length: ${overrides.length}`,
      sourceInstanceId: sourceInstance.id,
      mainComponentId: mainComponent.id,
      overridesCount: overrides.length
    };

    console.log("Data to return to MCP server:", returnData);
    figma.notify(`Got component information from "${sourceInstance.name}"`);

    return returnData;
  } catch (error) {
    console.error("Error in getInstanceOverrides:", error);
    figma.notify(`Error: ${error.message}`);
    return {
      success: false,
      message: `Error: ${error.message}`
    };
  }
}

/**
 * Helper function to validate and get target instances
 * @param {string[]} targetNodeIds - Array of instance node IDs
 * @returns {instanceNode[]} targetInstances - Array of target instances
 */
/**
 * Helper function to validate and get saved override data
 * @param {string} sourceInstanceId - Source instance ID
 * @returns {Promise<Object>} - Validation result with source instance data or error
 */
/**
 * Sets saved overrides to the selected component instance(s)
 * @param {InstanceNode[] | null} targetInstances - Array of instance nodes to set overrides to
 * @param {Object} sourceResult - Source instance data from getSourceInstanceData
 * @returns {Promise<Object>} - Result of the set operation
 */
// Set focus on a specific node
async function setFocus(params) {
  if (!params || !params.nodeId) {
    throw new Error("Missing nodeId parameter");
  }

  const node = await figma.getNodeByIdAsync(params.nodeId);
  if (!node) {
    throw new Error(`Node with ID ${params.nodeId} not found`);
  }

  // Set selection to the node
  figma.currentPage.selection = [node];

  // Scroll and zoom to show the node in viewport
  figma.viewport.scrollAndZoomIntoView([node]);

  return {
    success: true,
    name: node.name,
    id: node.id,
    message: `Focused on node "${node.name}"`
  };
}

// Set selection to multiple nodes
async function setSelections(params) {
  if (!params || !params.nodeIds || !Array.isArray(params.nodeIds)) {
    throw new Error("Missing or invalid nodeIds parameter");
  }

  if (params.nodeIds.length === 0) {
    throw new Error("nodeIds array cannot be empty");
  }

  // Get all valid nodes
  const nodes = [];
  const notFoundIds = [];

  for (const nodeId of params.nodeIds) {
    const node = await figma.getNodeByIdAsync(nodeId);
    if (node) {
      nodes.push(node);
    } else {
      notFoundIds.push(nodeId);
    }
  }

  if (nodes.length === 0) {
    throw new Error(`No valid nodes found for the provided IDs: ${params.nodeIds.join(', ')}`);
  }

  // Set selection to the nodes
  figma.currentPage.selection = nodes;

  // Scroll and zoom to show all nodes in viewport
  figma.viewport.scrollAndZoomIntoView(nodes);

  const selectedNodes = nodes.map(node => ({
    name: node.name,
    id: node.id
  }));

  return {
    success: true,
    count: nodes.length,
    selectedNodes: selectedNodes,
    notFoundIds: notFoundIds,
    message: `Selected ${nodes.length} nodes${notFoundIds.length > 0 ? ` (${notFoundIds.length} not found)` : ''}`
  };
}
