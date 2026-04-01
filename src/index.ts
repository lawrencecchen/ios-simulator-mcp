#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { execFile, spawn } from "child_process";
import { promisify } from "util";
import { z } from "zod";
import path from "path";
import os from "os";
import fs from "fs";

const execFileAsync = promisify(execFile);

/**
 * Strict UDID/UUID pattern: 8-4-4-4-12 hexadecimal characters (e.g. 37A360EC-75F9-4AEC-8EFA-10F4A58D8CCA)
 */
const UDID_REGEX =
  /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;

const TMP_ROOT_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), "ios-simulator-mcp-")
);

/**
 * Runs a command with arguments and returns the stdout and stderr
 * @param cmd - The command to run
 * @param args - The arguments to pass to the command
 * @returns The stdout and stderr of the command
 */
async function run(
  cmd: string,
  args: string[]
): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileAsync(cmd, args, { shell: false });
  return {
    stdout: stdout.trim(),
    stderr: stderr.trim(),
  };
}

/**
 * Gets the IDB command path from environment variable or defaults to "idb"
 * @returns The path to the IDB executable
 * @throws Error if custom path is specified but doesn't exist
 */
function getIdbPath(): string {
  const customPath = process.env.IOS_SIMULATOR_MCP_IDB_PATH;

  if (customPath) {
    // Expand tilde if present
    const expandedPath = customPath.startsWith("~/")
      ? path.join(os.homedir(), customPath.slice(2))
      : customPath;

    // Check if the path exists
    if (!fs.existsSync(expandedPath)) {
      throw new Error(
        `Custom IDB path specified in IOS_SIMULATOR_MCP_IDB_PATH does not exist: ${expandedPath}`
      );
    }

    return expandedPath;
  }

  return "idb";
}

/**
 * Runs the idb command with the given arguments
 * @param args - arguments to pass to the idb command
 * @returns The stdout and stderr of the command
 * @see https://fbidb.io/docs/commands for documentation of available idb commands
 */
async function idb(...args: string[]) {
  return run(getIdbPath(), args);
}

/**
 * Runs an idb UI command with automatic retry on cold-start empty results.
 * IDB lazily connects to testmanagerd; the first call after boot (or reboot)
 * often returns an empty accessibility tree. This wrapper detects that sentinel
 * and retries once after a short delay.
 */
async function idbUIWithRetry(...args: string[]) {
  const result = await idb(...args);

  // Detect cold-start empty result: single root element with zero-dimension frame
  if (args[0] === "ui" && (args[1] === "describe-all" || args[1] === "describe-point")) {
    try {
      const parsed = JSON.parse(result.stdout);
      const root = Array.isArray(parsed) ? parsed[0] : parsed;
      const frame = root?.frame;
      if (
        frame &&
        frame.width === 0 &&
        frame.height === 0 &&
        (!root.type || root.type === "None" || root.type === null)
      ) {
        // Cold start detected, wait and retry
        await new Promise((resolve) => setTimeout(resolve, 1500));
        return idb(...args);
      }
    } catch {
      // Parse failed, return original result
    }
  }

  return result;
}

// Read filtered tools from environment variable
const FILTERED_TOOLS =
  process.env.IOS_SIMULATOR_MCP_FILTERED_TOOLS?.split(",").map((tool) =>
    tool.trim()
  ) || [];

// Function to check if a tool is filtered
function isToolFiltered(toolName: string): boolean {
  return FILTERED_TOOLS.includes(toolName);
}

const server = new McpServer({
  name: "ios-simulator",
  version: require("../package.json").version,
});

function toError(input: unknown): Error {
  if (input instanceof Error) return input;

  if (
    typeof input === "object" &&
    input &&
    "message" in input &&
    typeof input.message === "string"
  )
    return new Error(input.message);

  return new Error(JSON.stringify(input));
}

function troubleshootingLink(): string {
  return "[Troubleshooting Guide](https://github.com/joshuayoes/ios-simulator-mcp/blob/main/TROUBLESHOOTING.md) | [Plain Text Guide for LLMs](https://raw.githubusercontent.com/joshuayoes/ios-simulator-mcp/refs/heads/main/TROUBLESHOOTING.md)";
}

function errorWithTroubleshooting(message: string): string {
  return `${message}\n\nFor help, see the ${troubleshootingLink()}`;
}

async function getBootedDevice() {
  const { stdout, stderr } = await run("xcrun", ["simctl", "list", "devices"]);

  if (stderr) throw new Error(stderr);

  // Parse the output to find booted device
  const lines = stdout.split("\n");
  for (const line of lines) {
    if (line.includes("Booted")) {
      // Extract the UUID - it's inside parentheses
      const match = line.match(/\(([-0-9A-F]+)\)/);
      if (match) {
        const deviceId = match[1];
        const deviceName = line.split("(")[0].trim();
        return {
          name: deviceName,
          id: deviceId,
        };
      }
    }
  }

  throw Error("No booted simulator found");
}

async function getBootedDeviceId(
  deviceId: string | undefined
): Promise<string> {
  // If deviceId not provided, get the currently booted simulator
  let actualDeviceId = deviceId;
  if (!actualDeviceId) {
    const { id } = await getBootedDevice();
    actualDeviceId = id;
  }
  if (!actualDeviceId) {
    throw new Error("No booted simulator found and no deviceId provided");
  }
  return actualDeviceId;
}

/**
 * Gets the device name for a given UDID from simctl
 */
async function getDeviceName(deviceId: string): Promise<string> {
  const { stdout } = await run("xcrun", ["simctl", "list", "devices", "-j"]);
  const devicesJson = JSON.parse(stdout);
  for (const [, devices] of Object.entries(devicesJson.devices)) {
    for (const device of devices as any[]) {
      if (device.udid === deviceId) {
        return device.name;
      }
    }
  }
  throw new Error(`Device with UDID ${deviceId} not found in simctl list`);
}

/**
 * Performs a tap on the iOS Simulator by injecting a CGEvent mouse click at the
 * corresponding macOS screen coordinates. This bypasses IDB and works for UI
 * elements that IDB cannot reach, such as inputAccessoryView buttons.
 *
 * Steps:
 * 1. Find the Simulator window for the target device by name
 * 2. Find the device screen content area within the window via accessibility
 * 3. Map iOS point coordinates to macOS screen coordinates
 * 4. Post CGEvent mouse down/up at the calculated position
 */
async function nativeTap(
  deviceId: string,
  iosX: number,
  iosY: number,
  duration?: number
): Promise<{ screenX: number; screenY: number; scale: number }> {
  const deviceName = await getDeviceName(deviceId);

  // Get device screen dimensions in iOS points
  const { stdout: describeOutput } = await idbUIWithRetry(
    "ui",
    "describe-all",
    "--udid",
    deviceId,
    "--json",
    "--nested"
  );
  const uiData = JSON.parse(describeOutput);
  const screenFrame = uiData[0]?.frame;
  if (!screenFrame) {
    throw new Error("Could not determine device screen dimensions from IDB");
  }
  const deviceW = screenFrame.width;
  const deviceH = screenFrame.height;

  const clickDuration = duration ?? 0.05;

  // Use JXA to find window, calculate coordinates, and click via CGEvent
  const jxaScript = `
(function() {
  ObjC.import("CoreGraphics");

  var deviceName = ${JSON.stringify(deviceName)};
  var iosX = ${iosX};
  var iosY = ${iosY};
  var deviceW = ${deviceW};
  var deviceH = ${deviceH};
  var clickDuration = ${clickDuration};

  // Find the Simulator window for this device
  var se = Application("System Events");
  var sim = se.processes.byName("Simulator");
  var wins = sim.windows();
  var targetWindow = null;
  for (var i = 0; i < wins.length; i++) {
    try {
      if (wins[i].name().includes(deviceName)) {
        targetWindow = wins[i];
        break;
      }
    } catch(e) {}
  }
  if (!targetWindow) {
    throw new Error("No Simulator window found for device: " + deviceName);
  }

  // Bring window to front
  var actions = targetWindow.actions();
  for (var i = 0; i < actions.length; i++) {
    if (actions[i].name() === "AXRaise") {
      actions[i].perform();
      break;
    }
  }
  Application("Simulator").activate();
  delay(0.2);

  // Find the device screen content area by looking for the AXGroup
  // whose size matches the device screen dimensions (or is proportional)
  var uiElems = targetWindow.uiElements();
  var contentX = -1, contentY = -1, contentW = -1, contentH = -1;
  for (var i = 0; i < uiElems.length; i++) {
    try {
      var role = uiElems[i].role();
      if (role !== "AXGroup") continue;
      var pos = uiElems[i].position();
      var size = uiElems[i].size();
      // Check if this group's aspect ratio matches the device screen
      var groupAR = size[0] / size[1];
      var deviceAR = deviceW / deviceH;
      if (Math.abs(groupAR - deviceAR) < 0.01) {
        contentX = pos[0];
        contentY = pos[1];
        contentW = size[0];
        contentH = size[1];
        break;
      }
    } catch(e) {}
  }

  if (contentX < 0) {
    throw new Error("Could not find device screen content area in Simulator window");
  }

  // Calculate scale and map coordinates
  var scaleX = contentW / deviceW;
  var scaleY = contentH / deviceH;
  var scale = scaleX; // Should be equal to scaleY given matching aspect ratio

  var screenX = contentX + (iosX * scale);
  var screenY = contentY + (iosY * scale);

  // Post CGEvent mouse click
  var point = $.CGPointMake(screenX, screenY);
  var mouseDown = $.CGEventCreateMouseEvent(null, $.kCGEventLeftMouseDown, point, 0);
  var mouseUp = $.CGEventCreateMouseEvent(null, $.kCGEventLeftMouseUp, point, 0);

  $.CGEventPost($.kCGHIDEventTap, mouseDown);
  delay(clickDuration);
  $.CGEventPost($.kCGHIDEventTap, mouseUp);

  return JSON.stringify({
    screenX: screenX,
    screenY: screenY,
    scale: scale,
    contentOrigin: { x: contentX, y: contentY },
    contentSize: { w: contentW, h: contentH }
  });
})();
`;

  const { stdout } = await run("osascript", ["-l", "JavaScript", "-e", jxaScript]);
  const result = JSON.parse(stdout);
  return {
    screenX: result.screenX,
    screenY: result.screenY,
    scale: result.scale,
  };
}

// Register tools only if they're not filtered
if (!isToolFiltered("get_booted_sim_id")) {
  server.tool(
    "get_booted_sim_id",
    "Get the ID of the currently booted iOS simulator",
    { title: "Get Booted Simulator ID", readOnlyHint: true, openWorldHint: true },
    async () => {
      try {
        const { id, name } = await getBootedDevice();

        return {
          isError: false,
          content: [
            {
              type: "text",
              text: `Booted Simulator: "${name}". UUID: "${id}"`,
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: errorWithTroubleshooting(
                `Error: ${toError(error).message}`
              ),
            },
          ],
        };
      }
    }
  );
}

if (!isToolFiltered("open_simulator")) {
  server.tool(
    "open_simulator",
    "Opens the iOS Simulator application",
    { title: "Open Simulator", readOnlyHint: false, openWorldHint: true },
    async () => {
      try {
        await run("open", ["-a", "Simulator.app"]);

        return {
          isError: false,
          content: [
            {
              type: "text",
              text: "Simulator.app opened successfully",
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: errorWithTroubleshooting(
                `Error opening Simulator.app: ${toError(error).message}`
              ),
            },
          ],
        };
      }
    }
  );
}

/**
 * Probes an area using idb describe-point to discover elements not returned by
 * describe-all (e.g. inputAccessoryView toolbar buttons). Scans horizontally
 * across the area at the vertical midpoint, stepping by stepSize points.
 */
async function probeAreaForHiddenElements(
  udid: string,
  frame: { x: number; y: number; width: number; height: number },
  stepSize: number = 20
): Promise<any[]> {
  const midY = Math.round(frame.y + frame.height / 2);
  const discovered = new Map<string, any>();

  for (let x = Math.round(frame.x + 5); x < frame.x + frame.width - 5; x += stepSize) {
    try {
      const { stdout } = await idb(
        "ui",
        "describe-point",
        "--udid",
        udid,
        "--json",
        "--",
        String(x),
        String(midY)
      );
      const element = JSON.parse(stdout);
      // Use AXUniqueId or frame as dedup key
      const key =
        element.AXUniqueId ||
        `${element.frame?.x}_${element.frame?.y}_${element.frame?.width}_${element.frame?.height}`;
      if (key && !discovered.has(key)) {
        // Skip if this is the parent group itself
        const ef = element.frame;
        if (
          ef &&
          Math.abs(ef.x - frame.x) < 1 &&
          Math.abs(ef.y - frame.y) < 1 &&
          Math.abs(ef.width - frame.width) < 1
        ) {
          continue;
        }
        discovered.set(key, element);
      }
    } catch {
      // describe-point can fail for coordinates outside the screen
    }
  }

  return Array.from(discovered.values());
}

if (!isToolFiltered("ui_describe_all")) {
  server.tool(
    "ui_describe_all",
    "Describes accessibility information for the entire screen in the iOS Simulator. Automatically discovers elements in inputAccessoryView toolbars that IDB's describe-all normally misses.",
    {
      udid: z
        .string()
        .regex(UDID_REGEX)
        .optional()
        .describe("Udid of target, can also be set with the IDB_UDID env var"),
    },
    { title: "Describe All UI Elements", readOnlyHint: true, openWorldHint: true },
    async ({ udid }) => {
      try {
        const actualUdid = await getBootedDeviceId(udid);

        const { stdout } = await idbUIWithRetry(
          "ui",
          "describe-all",
          "--udid",
          actualUdid,
          "--json",
          "--nested"
        );

        const elements = JSON.parse(stdout);

        // Find toolbar/group elements with no children and probe them
        // for hidden elements (e.g. inputAccessoryView buttons)
        const toolbarGroups: { x: number; y: number; width: number; height: number }[] = [];
        function findEmptyToolbars(items: any[]) {
          for (const item of items) {
            const label = (item.AXLabel || "").toLowerCase();
            const role = item.role || "";
            const children = item.children || [];
            const frame = item.frame;

            if (
              frame &&
              (label.includes("toolbar") || role === "AXToolbar") &&
              children.length === 0 &&
              frame.width > 50 &&
              frame.height > 20
            ) {
              toolbarGroups.push(frame);
            }

            if (children.length > 0) {
              findEmptyToolbars(children);
            }
          }
        }
        findEmptyToolbars(elements);

        // Probe each empty toolbar for hidden children
        if (toolbarGroups.length > 0) {
          const probeResults = await Promise.all(
            toolbarGroups.map((frame) =>
              probeAreaForHiddenElements(actualUdid, frame)
            )
          );

          // Add discovered elements to the output
          for (let i = 0; i < toolbarGroups.length; i++) {
            const discovered = probeResults[i];
            if (discovered.length > 0) {
              // Find the toolbar in the original elements and add children
              function addChildren(items: any[]): boolean {
                for (const item of items) {
                  const f = item.frame;
                  if (
                    f &&
                    Math.abs(f.x - toolbarGroups[i].x) < 1 &&
                    Math.abs(f.y - toolbarGroups[i].y) < 1
                  ) {
                    item.children = discovered;
                    item._probed = true;
                    return true;
                  }
                  if (item.children && addChildren(item.children)) {
                    return true;
                  }
                }
                return false;
              }
              if (!addChildren(elements)) {
                // If we can't find the parent, append as top-level
                for (const elem of discovered) {
                  elem._probed = true;
                  elements.push(elem);
                }
              }
            }
          }
        }

        return {
          isError: false,
          content: [{ type: "text", text: JSON.stringify(elements) }],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: errorWithTroubleshooting(
                `Error describing all of the ui: ${toError(error).message}`
              ),
            },
          ],
        };
      }
    }
  );
}

if (!isToolFiltered("ui_tap")) {
  server.tool(
    "ui_tap",
    "Tap on the screen in the iOS Simulator. Use method 'native' for elements that IDB cannot reach (e.g. inputAccessoryView buttons above the keyboard). Native mode injects a macOS CGEvent click on the Simulator window at the mapped coordinates.",
    {
      duration: z
        .string()
        .regex(/^\d+(\.\d+)?$/)
        .optional()
        .describe("Press duration"),
      udid: z
        .string()
        .regex(UDID_REGEX)
        .optional()
        .describe("Udid of target, can also be set with the IDB_UDID env var"),
      x: z.number().describe("The x-coordinate"),
      y: z.number().describe("The y-coordinate"),
      method: z
        .enum(["idb", "native"])
        .optional()
        .default("idb")
        .describe(
          "Tap method. 'idb' uses Facebook IDB (default). 'native' injects a macOS CGEvent click on the Simulator window, which can reach UI elements like inputAccessoryView that IDB cannot tap."
        ),
    },
    { title: "UI Tap", readOnlyHint: false, openWorldHint: true },
    async ({ duration, udid, x, y, method }) => {
      try {
        const actualUdid = await getBootedDeviceId(udid);

        if (method === "native") {
          const result = await nativeTap(
            actualUdid,
            x,
            y,
            duration ? parseFloat(duration) : undefined
          );
          return {
            isError: false,
            content: [
              {
                type: "text",
                text: `Tapped successfully (native) at macOS screen coordinates (${result.screenX.toFixed(1)}, ${result.screenY.toFixed(1)}), scale=${result.scale.toFixed(3)}`,
              },
            ],
          };
        }

        const { stderr } = await idb(
          "ui",
          "tap",
          "--udid",
          actualUdid,
          ...(duration ? ["--duration", duration] : []),
          "--json",
          // When passing user-provided values to a command, it's crucial to use `--`
          // to separate the command's options from positional arguments.
          // This prevents the shell from misinterpreting the arguments as options.
          "--",
          String(x),
          String(y)
        );

        if (stderr) throw new Error(stderr);

        return {
          isError: false,
          content: [{ type: "text", text: "Tapped successfully" }],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: errorWithTroubleshooting(
                `Error tapping on the screen: ${toError(error).message}`
              ),
            },
          ],
        };
      }
    }
  );
}

if (!isToolFiltered("ui_type")) {
  server.tool(
    "ui_type",
    "Input text into the iOS Simulator",
    {
      udid: z
        .string()
        .regex(UDID_REGEX)
        .optional()
        .describe("Udid of target, can also be set with the IDB_UDID env var"),
      text: z
        .string()
        .max(500)
        .regex(/^[\x20-\x7E]+$/)
        .describe("Text to input"),
    },
    { title: "UI Type", readOnlyHint: false, openWorldHint: true },
    async ({ udid, text }) => {
      try {
        const actualUdid = await getBootedDeviceId(udid);

        const { stderr } = await idb(
          "ui",
          "text",
          "--udid",
          actualUdid,
          // When passing user-provided values to a command, it's crucial to use `--`
          // to separate the command's options from positional arguments.
          // This prevents the shell from misinterpreting the arguments as options.
          "--",
          text
        );

        if (stderr) throw new Error(stderr);

        return {
          isError: false,
          content: [{ type: "text", text: "Typed successfully" }],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: errorWithTroubleshooting(
                `Error typing text into the iOS Simulator: ${
                  toError(error).message
                }`
              ),
            },
          ],
        };
      }
    }
  );
}

if (!isToolFiltered("ui_swipe")) {
  server.tool(
    "ui_swipe",
    "Swipe on the screen in the iOS Simulator",
    {
      duration: z
        .string()
        .regex(/^\d+(\.\d+)?$/)
        .optional()
        .describe("Swipe duration in seconds (e.g., 0.1)"),
      udid: z
        .string()
        .regex(UDID_REGEX)
        .optional()
        .describe("Udid of target, can also be set with the IDB_UDID env var"),
      x_start: z.number().describe("The starting x-coordinate"),
      y_start: z.number().describe("The starting y-coordinate"),
      x_end: z.number().describe("The ending x-coordinate"),
      y_end: z.number().describe("The ending y-coordinate"),
      delta: z
        .number()
        .optional()
        .describe("The size of each step in the swipe (default is 1)")
        .default(1),
    },
    { title: "UI Swipe", readOnlyHint: false, openWorldHint: true },
    async ({ duration, udid, x_start, y_start, x_end, y_end, delta }) => {
      try {
        const actualUdid = await getBootedDeviceId(udid);

        const { stderr } = await idb(
          "ui",
          "swipe",
          "--udid",
          actualUdid,
          ...(duration ? ["--duration", duration] : []),
          ...(delta ? ["--delta", String(delta)] : []),
          "--json",
          // When passing user-provided values to a command, it's crucial to use `--`
          // to separate the command's options from positional arguments.
          // This prevents the shell from misinterpreting the arguments as options.
          "--",
          String(x_start),
          String(y_start),
          String(x_end),
          String(y_end)
        );

        if (stderr) throw new Error(stderr);

        return {
          isError: false,
          content: [{ type: "text", text: "Swiped successfully" }],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: errorWithTroubleshooting(
                `Error swiping on the screen: ${toError(error).message}`
              ),
            },
          ],
        };
      }
    }
  );
}

if (!isToolFiltered("ui_describe_point")) {
  server.tool(
    "ui_describe_point",
    "Returns the accessibility element at given co-ordinates on the iOS Simulator's screen",
    {
      udid: z
        .string()
        .regex(UDID_REGEX)
        .optional()
        .describe("Udid of target, can also be set with the IDB_UDID env var"),
      x: z.number().describe("The x-coordinate"),
      y: z.number().describe("The y-coordinate"),
    },
    { title: "Describe UI Point", readOnlyHint: true, openWorldHint: true },
    async ({ udid, x, y }) => {
      try {
        const actualUdid = await getBootedDeviceId(udid);

        const { stdout, stderr } = await idbUIWithRetry(
          "ui",
          "describe-point",
          "--udid",
          actualUdid,
          "--json",
          // When passing user-provided values to a command, it's crucial to use `--`
          // to separate the command's options from positional arguments.
          // This prevents the shell from misinterpreting the arguments as options.
          "--",
          String(x),
          String(y)
        );

        if (stderr) throw new Error(stderr);

        return {
          isError: false,
          content: [{ type: "text", text: stdout }],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: errorWithTroubleshooting(
                `Error describing point (${x}, ${y}): ${toError(error).message}`
              ),
            },
          ],
        };
      }
    }
  );
}

if (!isToolFiltered("ui_view")) {
  server.tool(
    "ui_view",
    "Get the image content of a compressed screenshot of the current simulator view",
    {
      udid: z
        .string()
        .regex(UDID_REGEX)
        .optional()
        .describe("Udid of target, can also be set with the IDB_UDID env var"),
    },
    { title: "View Screenshot", readOnlyHint: true, openWorldHint: true },
    async ({ udid }) => {
      try {
        const actualUdid = await getBootedDeviceId(udid);

        // Get screen dimensions in points from ui_describe_all
        const { stdout: uiDescribeOutput } = await idbUIWithRetry(
          "ui",
          "describe-all",
          "--udid",
          actualUdid,
          "--json",
          "--nested"
        );

        const uiData = JSON.parse(uiDescribeOutput);
        const screenFrame = uiData[0]?.frame;
        if (!screenFrame) {
          throw new Error("Could not determine screen dimensions");
        }

        const pointWidth = screenFrame.width;
        const pointHeight = screenFrame.height;

        // Generate unique file names with timestamp
        const ts = Date.now();
        const rawPng = path.join(TMP_ROOT_DIR, `ui-view-${ts}-raw.png`);
        const compressedJpg = path.join(
          TMP_ROOT_DIR,
          `ui-view-${ts}-compressed.jpg`
        );

        // Capture screenshot as PNG
        await run("xcrun", [
          "simctl",
          "io",
          actualUdid,
          "screenshot",
          "--type=png",
          "--",
          rawPng,
        ]);

        // Resize to match point dimensions and compress to JPEG using sips
        await run("sips", [
          "-z",
          String(pointHeight), // height in points
          String(pointWidth), // width in points
          "-s",
          "format",
          "jpeg",
          "-s",
          "formatOptions",
          "80", // 80% quality
          rawPng,
          "--out",
          compressedJpg,
        ]);

        // Read and encode the compressed image
        const imageData = fs.readFileSync(compressedJpg);
        const base64Data = imageData.toString("base64");

        return {
          isError: false,
          content: [
            {
              type: "image",
              data: base64Data,
              mimeType: "image/jpeg",
            },
            {
              type: "text",
              text: "Screenshot captured",
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: errorWithTroubleshooting(
                `Error capturing screenshot: ${toError(error).message}`
              ),
            },
          ],
        };
      }
    }
  );
}

function ensureAbsolutePath(filePath: string): string {
  if (path.isAbsolute(filePath)) {
    return filePath;
  }

  // Handle ~/something paths in the provided filePath
  if (filePath.startsWith("~/")) {
    return path.join(os.homedir(), filePath.slice(2));
  }

  // Determine the default directory from env var or fallback to ~/Downloads
  let defaultDir = path.join(os.homedir(), "Downloads");
  const customDefaultDir = process.env.IOS_SIMULATOR_MCP_DEFAULT_OUTPUT_DIR;

  if (customDefaultDir) {
    // also expand tilde for the custom directory path
    if (customDefaultDir.startsWith("~/")) {
      defaultDir = path.join(os.homedir(), customDefaultDir.slice(2));
    } else {
      defaultDir = customDefaultDir;
    }
  }

  // Join the relative filePath with the resolved default directory
  return path.join(defaultDir, filePath);
}

if (!isToolFiltered("screenshot")) {
  server.tool(
    "screenshot",
    "Takes a screenshot of the iOS Simulator",
    {
      udid: z
        .string()
        .regex(UDID_REGEX)
        .optional()
        .describe("Udid of target, can also be set with the IDB_UDID env var"),
      output_path: z
        .string()
        .max(1024)
        .describe(
          "File path where the screenshot will be saved. If relative, it uses the directory specified by the `IOS_SIMULATOR_MCP_DEFAULT_OUTPUT_DIR` env var, or `~/Downloads` if not set."
        ),
      type: z
        .enum(["png", "tiff", "bmp", "gif", "jpeg"])
        .optional()
        .describe(
          "Image format (png, tiff, bmp, gif, or jpeg). Default is png."
        ),
      display: z
        .enum(["internal", "external"])
        .optional()
        .describe(
          "Display to capture (internal or external). Default depends on device type."
        ),
      mask: z
        .enum(["ignored", "alpha", "black"])
        .optional()
        .describe(
          "For non-rectangular displays, handle the mask by policy (ignored, alpha, or black)"
        ),
    },
    { title: "Take Screenshot", readOnlyHint: false, openWorldHint: true },
    async ({ udid, output_path, type, display, mask }) => {
      try {
        const actualUdid = await getBootedDeviceId(udid);
        const absolutePath = ensureAbsolutePath(output_path);

        // command is weird, it responds with stderr on success and stdout is blank
        const { stderr: stdout } = await run("xcrun", [
          "simctl",
          "io",
          actualUdid,
          "screenshot",
          ...(type ? [`--type=${type}`] : []),
          ...(display ? [`--display=${display}`] : []),
          ...(mask ? [`--mask=${mask}`] : []),
          // When passing user-provided values to a command, it's crucial to use `--`
          // to separate the command's options from positional arguments.
          // This prevents the shell from misinterpreting the arguments as options.
          "--",
          absolutePath,
        ]);

        // throw if we don't get the expected success message
        if (stdout && !stdout.includes("Wrote screenshot to")) {
          throw new Error(stdout);
        }

        return {
          isError: false,
          content: [
            {
              type: "text",
              text: stdout,
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: errorWithTroubleshooting(
                `Error taking screenshot: ${toError(error).message}`
              ),
            },
          ],
        };
      }
    }
  );
}

if (!isToolFiltered("record_video")) {
  server.tool(
    "record_video",
    "Records a video of the iOS Simulator using simctl directly",
    {
      output_path: z
        .string()
        .max(1024)
        .optional()
        .describe(
          `Optional output path. If not provided, a default name will be used. The file will be saved in the directory specified by \`IOS_SIMULATOR_MCP_DEFAULT_OUTPUT_DIR\` or in \`~/Downloads\` if the environment variable is not set.`
        ),
      codec: z
        .enum(["h264", "hevc"])
        .optional()
        .describe(
          'Specifies the codec type: "h264" or "hevc". Default is "hevc".'
        ),
      display: z
        .enum(["internal", "external"])
        .optional()
        .describe(
          'Display to capture: "internal" or "external". Default depends on device type.'
        ),
      mask: z
        .enum(["ignored", "alpha", "black"])
        .optional()
        .describe(
          'For non-rectangular displays, handle the mask by policy: "ignored", "alpha", or "black".'
        ),
      force: z
        .boolean()
        .optional()
        .describe(
          "Force the output file to be written to, even if the file already exists."
        ),
    },
    { title: "Record Video", readOnlyHint: false, openWorldHint: true },
    async ({ output_path, codec, display, mask, force }) => {
      try {
        const defaultFileName = `simulator_recording_${Date.now()}.mp4`;
        const outputFile = ensureAbsolutePath(output_path ?? defaultFileName);

        // Start the recording process
        const recordingProcess = spawn("xcrun", [
          "simctl",
          "io",
          "booted",
          "recordVideo",
          ...(codec ? [`--codec=${codec}`] : []),
          ...(display ? [`--display=${display}`] : []),
          ...(mask ? [`--mask=${mask}`] : []),
          ...(force ? ["--force"] : []),
          // When passing user-provided values to a command, it's crucial to use `--`
          // to separate the command's options from positional arguments.
          // This prevents the shell from misinterpreting the arguments as options.
          "--",
          outputFile,
        ]);

        // Wait for recording to start
        await new Promise((resolve, reject) => {
          let errorOutput = "";

          recordingProcess.stderr.on("data", (data) => {
            const message = data.toString();
            if (message.includes("Recording started")) {
              resolve(true);
            } else {
              errorOutput += message;
            }
          });

          // Set timeout for start verification
          setTimeout(() => {
            if (recordingProcess.killed) {
              reject(new Error("Recording process terminated unexpectedly"));
            } else {
              resolve(true);
            }
          }, 3000);
        });

        return {
          isError: false,
          content: [
            {
              type: "text",
              text: `Recording started. The video will be saved to: ${outputFile}\nTo stop recording, use the stop_recording command.`,
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: errorWithTroubleshooting(
                `Error starting recording: ${toError(error).message}`
              ),
            },
          ],
        };
      }
    }
  );
}

if (!isToolFiltered("stop_recording")) {
  server.tool(
    "stop_recording",
    "Stops the simulator video recording using killall",
    {},
    { title: "Stop Recording", readOnlyHint: false, openWorldHint: true },
    async () => {
      try {
        await run("pkill", ["-SIGINT", "-f", "simctl.*recordVideo"]);

        // Wait a moment for the video to finalize
        await new Promise((resolve) => setTimeout(resolve, 1000));

        return {
          isError: false,
          content: [
            {
              type: "text",
              text: "Recording stopped successfully.",
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: errorWithTroubleshooting(
                `Error stopping recording: ${toError(error).message}`
              ),
            },
          ],
        };
      }
    }
  );
}

if (!isToolFiltered("install_app")) {
  server.tool(
    "install_app",
    "Installs an app bundle (.app or .ipa) on the iOS Simulator",
    {
      udid: z
        .string()
        .regex(UDID_REGEX)
        .optional()
        .describe("Udid of target, can also be set with the IDB_UDID env var"),
      app_path: z
        .string()
        .max(1024)
        .describe(
          "Path to the app bundle (.app directory or .ipa file) to install"
        ),
    },
    { title: "Install App", readOnlyHint: false, openWorldHint: true },
    async ({ udid, app_path }) => {
      try {
        const actualUdid = await getBootedDeviceId(udid);
        const absolutePath = path.isAbsolute(app_path)
          ? app_path
          : path.resolve(app_path);

        // Check if the app bundle exists
        if (!fs.existsSync(absolutePath)) {
          throw new Error(`App bundle not found at: ${absolutePath}`);
        }

        // run() will throw if the command fails (non-zero exit code)
        await run("xcrun", ["simctl", "install", actualUdid, absolutePath]);

        return {
          isError: false,
          content: [
            {
              type: "text",
              text: `App installed successfully from: ${absolutePath}`,
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: errorWithTroubleshooting(
                `Error installing app: ${toError(error).message}`
              ),
            },
          ],
        };
      }
    }
  );
}

if (!isToolFiltered("launch_app")) {
  server.tool(
    "launch_app",
    "Launches an app on the iOS Simulator by bundle identifier",
    {
      udid: z
        .string()
        .regex(UDID_REGEX)
        .optional()
        .describe("Udid of target, can also be set with the IDB_UDID env var"),
      bundle_id: z
        .string()
        .max(256)
        .describe(
          "Bundle identifier of the app to launch (e.g., com.apple.mobilesafari)"
        ),
      terminate_running: z
        .boolean()
        .optional()
        .describe(
          "Terminate the app if it is already running before launching"
        ),
    },
    { title: "Launch App", readOnlyHint: false, openWorldHint: true },
    async ({ udid, bundle_id, terminate_running }) => {
      try {
        const actualUdid = await getBootedDeviceId(udid);

        // run() will throw if the command fails (non-zero exit code)
        const { stdout } = await run("xcrun", [
          "simctl",
          "launch",
          ...(terminate_running ? ["--terminate-running-process"] : []),
          actualUdid,
          bundle_id,
        ]);

        // Extract PID from output if available
        // simctl launch outputs the PID as the first token in stdout
        const pidMatch = stdout.match(/^(\d+)/);
        const pid = pidMatch ? pidMatch[1] : null;

        return {
          isError: false,
          content: [
            {
              type: "text",
              text: pid
                ? `App ${bundle_id} launched successfully with PID: ${pid}`
                : `App ${bundle_id} launched successfully`,
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: errorWithTroubleshooting(
                `Error launching app: ${toError(error).message}`
              ),
            },
          ],
        };
      }
    }
  );
}

async function runServer() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

runServer().catch(console.error);

process.stdin.on("close", () => {
  console.log("iOS Simulator MCP Server closed");
  server.close();
  try {
    fs.rmSync(TMP_ROOT_DIR, { recursive: true, force: true });
  } catch (error) {
    // Ignore cleanup errors
  }
});
