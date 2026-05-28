#!/usr/bin/env bun

import { Server, ServerWebSocket } from "bun";

type ClientRole = "mcp" | "plugin" | "unknown";

interface ClientMeta {
  role: ClientRole;
  /** MCP client: session ids registered on this socket */
  sessionIds: Set<string>;
}

interface ChannelState {
  clients: Set<ServerWebSocket<unknown>>;
  plugins: Set<ServerWebSocket<unknown>>;
  /** Routes plugin responses to the MCP socket that owns the session */
  mcpSessions: Map<string, ServerWebSocket<unknown>>;
}

/** request id → session (for plugin replies that omit sessionId) */
const pendingRoutes = new Map<string, { channel: string; sessionId: string }>();

const wsMeta = new WeakMap<ServerWebSocket<unknown>, ClientMeta>();
const channels = new Map<string, ChannelState>();
const channelDescriptions = new Map<string, string>();

function getMeta(ws: ServerWebSocket<unknown>): ClientMeta {
  let meta = wsMeta.get(ws);
  if (!meta) {
    meta = { role: "unknown", sessionIds: new Set() };
    wsMeta.set(ws, meta);
  }
  return meta;
}

function getChannelState(channelName: string): ChannelState {
  let state = channels.get(channelName);
  if (!state) {
    state = {
      clients: new Set(),
      plugins: new Set(),
      mcpSessions: new Map(),
    };
    channels.set(channelName, state);
  }
  return state;
}

function removeClientFromChannels(ws: ServerWebSocket<unknown>) {
  const meta = wsMeta.get(ws);
  channels.forEach((state, channelName) => {
    if (state.clients.has(ws)) {
      state.clients.delete(ws);
      state.plugins.delete(ws);
      if (meta) {
        for (const sessionId of meta.sessionIds) {
          if (state.mcpSessions.get(sessionId) === ws) {
            state.mcpSessions.delete(sessionId);
          }
        }
      }
      for (const [requestId, route] of pendingRoutes.entries()) {
        if (route.channel === channelName && state.mcpSessions.get(route.sessionId) === ws) {
          pendingRoutes.delete(requestId);
        }
      }
    }
  });
  wsMeta.delete(ws);
}

function sendJson(ws: ServerWebSocket<unknown>, payload: unknown) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function handleConnection(ws: ServerWebSocket<unknown>) {
  console.log("New client connected");
  getMeta(ws);

  sendJson(ws, {
    type: "system",
    message: "Please join a channel to start chatting",
  });

  ws.close = () => {
    console.log("Client disconnected");
    removeClientFromChannels(ws);
  };
}

const server = Bun.serve({
  hostname: process.env.HOST || "0.0.0.0",
  port: Number(process.env.PORT || "3055"),
  fetch(req: Request, server: Server) {
    if (req.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
        },
      });
    }

    const success = server.upgrade(req, {
      headers: {
        "Access-Control-Allow-Origin": "*",
      },
    });

    if (success) {
      return;
    }

    return new Response("WebSocket server running", {
      headers: {
        "Access-Control-Allow-Origin": "*",
      },
    });
  },
  websocket: {
    open: handleConnection,
    message(ws: ServerWebSocket<unknown>, message: string | Buffer) {
      try {
        const data = JSON.parse(message as string) as Record<string, unknown>;
        const meta = getMeta(ws);

        console.log(`\n=== Received message from client ===`);
        console.log(`Type: ${data.type}, Channel: ${data.channel || "N/A"}`);
        const inner = data.message as Record<string, unknown> | undefined;
        if (inner?.command) {
          console.log(`Command: ${inner.command}, ID: ${inner.id}`);
        } else if (inner?.result !== undefined || inner?.error) {
          console.log(`Response: ID: ${inner.id}, sessionId: ${inner.sessionId || data.sessionId || "N/A"}`);
        }

        if (data.type === "list_channels") {
          const requestId = data.id;
          if (!requestId || typeof requestId !== "string") {
            sendJson(ws, {
              type: "error",
              message: "list_channels requires a string id",
            });
            return;
          }
          const list: { name: string; clientCount: number; description?: string }[] = [];
          for (const [name, state] of channels) {
            let clientCount = 0;
            for (const c of state.clients) {
              if (c.readyState === WebSocket.OPEN) clientCount++;
            }
            if (clientCount > 0) {
              const description = channelDescriptions.get(name);
              list.push({
                name,
                clientCount,
                ...(description ? { description } : {}),
              });
            }
          }
          list.sort((a, b) => a.name.localeCompare(b.name));
          sendJson(ws, {
            type: "channel_list",
            id: requestId,
            channels: list,
          });
          console.log(`\n✓ list_channels → ${list.length} active channel(s)`);
          return;
        }

        if (data.type === "register_session") {
          const channelName = data.channel;
          const sessionId = data.sessionId;
          if (
            typeof channelName !== "string" ||
            typeof sessionId !== "string" ||
            !channelName.trim() ||
            !sessionId.trim()
          ) {
            sendJson(ws, {
              type: "error",
              message: "register_session requires channel and sessionId",
            });
            return;
          }
          const state = getChannelState(channelName.trim());
          if (!state.clients.has(ws)) {
            sendJson(ws, {
              type: "error",
              message: "You must join the channel before registering a session",
            });
            return;
          }
          meta.role = "mcp";
          meta.sessionIds.add(sessionId.trim());
          state.mcpSessions.set(sessionId.trim(), ws);
          console.log(
            `\n✓ Registered MCP session "${sessionId}" on channel "${channelName}"`
          );
          sendJson(ws, {
            type: "system",
            message: { id: data.id, result: `Registered session ${sessionId}` },
            channel: channelName,
          });
          return;
        }

        if (data.type === "join") {
          const channelName = data.channel;
          const channelDescription =
            typeof data.channel_description === "string"
              ? data.channel_description.trim()
              : typeof (data.message as Record<string, unknown> | undefined)?.params === "object" &&
                  (data.message as { params?: { channel_description?: string } }).params
                    ?.channel_description === "string"
                ? String(
                    (data.message as { params: { channel_description: string } }).params
                      .channel_description
                  ).trim()
                : "";
          if (!channelName || typeof channelName !== "string") {
            sendJson(ws, { type: "error", message: "Channel name is required" });
            return;
          }

          const state = getChannelState(channelName);
          state.clients.add(ws);

          const joinSessionId =
            typeof data.sessionId === "string" ? data.sessionId.trim() : "";
          if (joinSessionId) {
            meta.role = "mcp";
            meta.sessionIds.add(joinSessionId);
            state.mcpSessions.set(joinSessionId, ws);
          } else {
            meta.role = "plugin";
            state.plugins.add(ws);
          }

          if (channelDescription) {
            channelDescriptions.set(channelName, channelDescription);
          }

          console.log(
            `\n✓ Client joined channel "${channelName}" as ${meta.role} (${state.clients.size} clients)`
          );

          sendJson(ws, {
            type: "system",
            message: `Joined channel: ${channelName}`,
            channel: channelName,
          });

          sendJson(ws, {
            type: "system",
            message: {
              id: data.id,
              result: "Connected to channel: " + channelName,
            },
            channel: channelName,
          });

          state.clients.forEach((client) => {
            if (client !== ws && client.readyState === WebSocket.OPEN) {
              sendJson(client, {
                type: "system",
                message: "A new user has joined the channel",
                channel: channelName,
              });
            }
          });
          return;
        }

        if (data.type === "message") {
          const channelName = data.channel;
          if (!channelName || typeof channelName !== "string") {
            sendJson(ws, { type: "error", message: "Channel name is required" });
            return;
          }

          const state = getChannelState(channelName);
          if (!state.clients.has(ws)) {
            sendJson(ws, {
              type: "error",
              message: "You must join the channel first",
            });
            return;
          }

          const innerMessage = (data.message || {}) as Record<string, unknown>;
          const sessionId =
            (typeof data.sessionId === "string" && data.sessionId.trim()) ||
            (typeof innerMessage.sessionId === "string" && innerMessage.sessionId.trim()) ||
            "";

          const isCommand = typeof innerMessage.command === "string";
          const isResponse =
            innerMessage.result !== undefined || typeof innerMessage.error === "string";

          if (isCommand && sessionId) {
            meta.role = "mcp";
            meta.sessionIds.add(sessionId);
            state.mcpSessions.set(sessionId, ws);
            const requestId = typeof innerMessage.id === "string" ? innerMessage.id : "";
            if (requestId) {
              pendingRoutes.set(requestId, { channel: channelName, sessionId });
            }

            let sent = 0;
            state.plugins.forEach((client) => {
              if (client.readyState === WebSocket.OPEN) {
                sent++;
                sendJson(client, {
                  type: "broadcast",
                  message: innerMessage,
                  sender: "peer",
                  channel: channelName,
                  sessionId,
                });
              }
            });
            if (sent === 0) {
              console.log(
                `⚠️  No Figma plugin in channel "${channelName}" for session "${sessionId}"`
              );
            } else {
              console.log(
                `✓ Routed command to ${sent} plugin(s) [session=${sessionId}, channel=${channelName}]`
              );
            }
            return;
          }

          if (isResponse && sessionId) {
            const requestId = typeof innerMessage.id === "string" ? innerMessage.id : "";
            if (requestId) pendingRoutes.delete(requestId);

            const targetWs = state.mcpSessions.get(sessionId);
            if (targetWs && targetWs.readyState === WebSocket.OPEN) {
              sendJson(targetWs, {
                type: "message",
                channel: channelName,
                sessionId,
                message: innerMessage,
              });
              console.log(
                `✓ Routed response to MCP session "${sessionId}" [request=${requestId}]`
              );
            } else {
              console.log(`⚠️  No MCP client for session "${sessionId}"`);
            }
            return;
          }

          if (isResponse && !sessionId) {
            const requestId = typeof innerMessage.id === "string" ? innerMessage.id : "";
            const route = requestId ? pendingRoutes.get(requestId) : undefined;
            const resolvedSessionId = route?.sessionId;
            if (resolvedSessionId && route) {
              pendingRoutes.delete(requestId);
              const targetWs = state.mcpSessions.get(resolvedSessionId);
              if (targetWs && targetWs.readyState === WebSocket.OPEN) {
                sendJson(targetWs, {
                  type: "message",
                  channel: channelName,
                  sessionId: resolvedSessionId,
                  message: { ...innerMessage, sessionId: resolvedSessionId },
                });
                console.log(
                  `✓ Routed response via pending route to session "${resolvedSessionId}"`
                );
                return;
              }
            }
          }

          // Legacy: broadcast to all other clients in channel (no session isolation)
          let broadcastCount = 0;
          state.clients.forEach((client) => {
            if (client !== ws && client.readyState === WebSocket.OPEN) {
              broadcastCount++;
              sendJson(client, {
                type: "broadcast",
                message: innerMessage,
                sender: "peer",
                channel: channelName,
              });
            }
          });
          if (broadcastCount === 0) {
            console.log(`⚠️  No peers in channel "${channelName}" (legacy broadcast)`);
          }
          return;
        }

        if (data.type === "progress_update") {
          const channelName = data.channel;
          if (!channelName || typeof channelName !== "string") return;

          const state = getChannelState(channelName);
          if (!state.clients.has(ws)) return;

          const sessionId =
            (typeof data.sessionId === "string" && data.sessionId.trim()) ||
            (typeof (data.message as Record<string, unknown> | undefined)?.sessionId ===
              "string" &&
              String((data.message as { sessionId: string }).sessionId).trim()) ||
            "";

          if (sessionId) {
            const targetWs = state.mcpSessions.get(sessionId);
            if (targetWs && targetWs !== ws && targetWs.readyState === WebSocket.OPEN) {
              sendJson(targetWs, data);
            }
            return;
          }

          state.clients.forEach((client) => {
            if (client !== ws && client.readyState === WebSocket.OPEN) {
              sendJson(client, data);
            }
          });
        }
      } catch (err) {
        console.error("Error handling message:", err);
      }
    },
    close(ws: ServerWebSocket<unknown>) {
      removeClientFromChannels(ws);
      for (const [channelName, state] of channels.entries()) {
        let openClientCount = 0;
        for (const client of state.clients) {
          if (client.readyState === WebSocket.OPEN) openClientCount++;
        }
        if (openClientCount === 0) {
          channels.delete(channelName);
          channelDescriptions.delete(channelName);
        }
      }
    },
  },
});

console.log(`WebSocket server running on port ${server.port}`);
