import fs from "fs/promises";
import path from "path";

async function main() {
  // Load env.local if it exists to get DATABASE_URL
  const envPath = path.resolve("./.env.local");
  let databaseUrl = process.env.DATABASE_URL;

  try {
    const envContent = await fs.readFile(envPath, "utf-8");
    const match = envContent.match(/^DATABASE_URL\s*=\s*([^\r\n]+)/m);
    if (match && match[1]) {
      databaseUrl = match[1].trim().replace(/(^['"]|['"]$)/g, ""); // Strip quotes if any
    }
  } catch (e) {
    // Ignore if file doesn't exist
  }

  if (!databaseUrl) {
    console.error("Error: DATABASE_URL not found in environment or .env.local");
    process.exit(1);
  }

  // Claude Desktop config path on Windows
  const appData = process.env.APPDATA;
  if (!appData) {
    console.error("Error: APPDATA environment variable is not defined (this installer is designed for Windows)");
    process.exit(1);
  }

  const configDir = path.join(appData, "Claude");
  const configPath = path.join(configDir, "claude_desktop_config.json");

  // Create directory if it doesn't exist
  await fs.mkdir(configDir, { recursive: true });

  interface McpConfig {
    mcpServers: Record<string, {
      command: string;
      args: string[];
      env?: Record<string, string>;
    }>;
  }

  let config: McpConfig = { mcpServers: {} };
  try {
    const existingContent = await fs.readFile(configPath, "utf-8");
    config = JSON.parse(existingContent) as McpConfig;
    if (!config.mcpServers) {
      config.mcpServers = {};
    }
  } catch (e) {
    // File doesn't exist or is invalid JSON, use default
  }

  const projectDir = path.resolve("./");
  const serverPath = path.join(projectDir, "src/mcp/server.ts").replace(/\\/g, "/");

  config.mcpServers["beez-trackz"] = {
    command: "npx",
    args: [
      "-y",
      "tsx",
      serverPath
    ],
    env: {
      DATABASE_URL: databaseUrl
    }
  };

  await fs.writeFile(configPath, JSON.stringify(config, null, 2), "utf-8");
  console.log(`Successfully registered Beez-Trackz MCP server!`);
  console.log(`Config path: ${configPath}`);
  console.log(`Project server path: ${serverPath}`);
  console.log(`Please restart Claude Desktop to apply the changes.`);
}

main().catch((err) => {
  console.error("Failed to register MCP server:", err);
});
