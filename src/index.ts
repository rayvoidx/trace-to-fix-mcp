#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server/mcpServer.js";
import { logger } from "./utils/logger.js";

async function main() {
  logger.info("Starting Trace-to-Fix MCP server...");

  const server = createServer();
  const transport = new StdioServerTransport();

  await server.connect(transport);

  logger.info("Trace-to-Fix MCP server running on stdio");
}

main().catch((err) => {
  logger.fatal(err, "Failed to start server");
  process.exit(1);
});
