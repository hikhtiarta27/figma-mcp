# WebSocket relay for figma-mcp (routes MCP ↔ Figma plugin by channel + sessionId)
FROM oven/bun:1.2-alpine

WORKDIR /app

COPY src/socket.ts ./socket.ts

ENV HOST=0.0.0.0
ENV PORT=3055

EXPOSE 3055

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD bun -e "const p=process.env.PORT||3055;fetch('http://127.0.0.1:'+p).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["bun", "socket.ts"]
