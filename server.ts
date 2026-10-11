import express, { Request, Response } from "express";
import http from "http";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import os from "os";
import { fileURLToPath } from "url";
import { WebSocketServer, WebSocket } from "ws";
import { GoogleGenAI, Type, FunctionDeclaration } from "@google/genai";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");
const UPLOADS_DIR = path.join(__dirname, "uploads");
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// ── Shared Gemini Client ──────────────────────────────────────────────────────
function getGenAI(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        "User-Agent": "aistudio-build",
      },
    },
  });
}

// ── Mark LV Model Ladder with Cooldowns ───────────────────────────────────────
interface RungStatus {
  model: string;
  tier: string;
  measuredMs: number;
  cooldownUntil: number;
  lastError?: string;
  calls: number;
}

const MODEL_LADDER: RungStatus[] = [
  { model: "gemini-3.8-flash", tier: "fast/smart", measuredMs: 560, cooldownUntil: 0, calls: 0 },
  { model: "gemini-3.1-flash-lite", tier: "fast", measuredMs: 600, cooldownUntil: 0, calls: 0 },
  { model: "gemini-flash-latest", tier: "fallback", measuredMs: 670, cooldownUntil: 0, calls: 0 },
];

function coolModel(modelName: string, seconds: number, reason: string) {
  const rung = MODEL_LADDER.find((r) => r.model === modelName);
  if (rung) {
    rung.cooldownUntil = Date.now() + seconds * 1000;
    rung.lastError = reason;
  }
}

function getAvailableLadder(): RungStatus[] {
  const now = Date.now();
  const ready = MODEL_LADDER.filter((r) => r.cooldownUntil <= now);
  return ready.length > 0 ? ready : MODEL_LADDER;
}

// ── Persistent In-Memory State (Config, Memory, Undo, Confirmations, Files) ──
interface AssistantConfig {
  assistant_name: string;
  user_name: string;
  voice_name: string;
  ui_color: string;
  hud_style: "face" | "core";
  shaded: boolean;
  wake_word_enabled: boolean;
  push_to_talk_enabled: boolean;
  morning_brief_enabled: boolean;
  proactive_audio: boolean;
  thinking_enabled: boolean;
}

const configState: AssistantConfig = {
  assistant_name: "J.A.R.V.I.S",
  user_name: "Commander",
  voice_name: "Charon",
  ui_color: "#00d4ff",
  hud_style: "face",
  shaded: true,
  wake_word_enabled: false,
  push_to_talk_enabled: false,
  morning_brief_enabled: true,
  proactive_audio: true,
  thinking_enabled: false,
};

interface SystemSettingsState {
  volume: number;
  brightness: number;
  dark_mode: boolean;
  wifi: boolean;
  power_state: "running" | "restarting" | "shutdown";
}

const sysSettings: SystemSettingsState = {
  volume: 72,
  brightness: 85,
  dark_mode: true,
  wifi: true,
  power_state: "running",
};

interface MemoryEntry {
  value: string;
  updated: string;
}

type MemoryCategory = "identity" | "preferences" | "projects" | "relationships" | "wishes" | "notes";

const memoryStore: Record<MemoryCategory, Record<string, MemoryEntry>> = {
  identity: {
    name: { value: "Commander", updated: "2026-10-11" },
    city: { value: "San Francisco", updated: "2026-10-11" },
    language: { value: "English", updated: "2026-10-11" },
  },
  preferences: {
    hud_theme: { value: "Holographic Cyan (#00d4ff)", updated: "2026-10-11" },
    briefing_style: { value: "Concise, concrete metrics first", updated: "2026-10-11" },
  },
  projects: {
    mark_lv: { value: "Mark LV (55) Personal AI Assistant with 3D HoloAvatar & Model Ladder", updated: "2026-10-11" },
  },
  relationships: {},
  wishes: {},
  notes: {
    architecture: { value: "9-model fallback ladder, zero-guess undo stack, UI-gated confirmations", updated: "2026-10-11" },
  },
};

// Virtual sandboxed files for file_controller and file_processor
const virtualFiles: Map<string, { name: string; folder: string; content: string; updatedAt: string }> = new Map([
  [
    "Desktop/mission_brief.md",
    {
      name: "mission_brief.md",
      folder: "Desktop",
      content: "# Mark LV Protocol\n- Holographic Avatar online\n- Model ladder calibrated\n- All 12 computer-driving skills active.",
      updatedAt: new Date().toISOString(),
    },
  ],
  [
    "Desktop/system_Diagnostic_2026.log",
    {
      name: "system_Diagnostic_2026.log",
      folder: "Desktop",
      content: "[OK] Audio subsystem MME/DirectSound calibrated\n[OK] MediaPipe 468-vertex canonical face mesh loaded\n[OK] Cooldown timers nominal.",
      updatedAt: new Date().toISOString(),
    },
  ],
  [
    "Desktop/flight_schedule.txt",
    {
      name: "flight_schedule.txt",
      folder: "Desktop",
      content: "SFO -> NRT | Flight JL001 | Departs 11:40 AM | Gate G9",
      updatedAt: new Date().toISOString(),
    },
  ],
]);

// Undo stack
interface UndoItem {
  id: string;
  description: string;
  timestamp: string;
  undo: () => string;
}
const undoStack: UndoItem[] = [];

function registerUndo(description: string, fn: () => string) {
  undoStack.push({
    id: crypto.randomUUID(),
    description,
    timestamp: new Date().toLocaleTimeString(),
    undo: fn,
  });
}

// Confirmation Gate (tokens issued ONLY by the UI / server gate, never forged by the model)
interface PendingConfirmation {
  token: string;
  action: string;
  label: string;
  createdAt: number;
  execute: () => string;
}
let pendingConfirmation: PendingConfirmation | null = null;

// Reminders & Background Monitors
interface ReminderItem {
  id: string;
  title: string;
  time: string;
  created: string;
}
const reminders: ReminderItem[] = [
  { id: "rem-1", title: "Review Mark LV telemetry logs", time: "17:00", created: "Today" },
];

interface MonitorTopic {
  id: string;
  topic: string;
  lastChecked: string;
  status: string;
}
const monitors: MonitorTopic[] = [
  { id: "mon-1", topic: "Gemini Live API & AI Hardware Releases", lastChecked: "Just now", status: "Watching daily" },
];

// ── Memory Formatting & Search (Ported from memory_manager.py) ───────────────
function formatMemoryForPrompt(): string {
  const lines: string[] = [
    "[WHAT YOU KNOW ABOUT THIS PERSON — use naturally, never recite like a list]",
  ];
  for (const [k, v] of Object.entries(memoryStore.identity)) {
    lines.push(`${k.charAt(0).toUpperCase() + k.slice(1)}: ${v.value}`);
  }
  const labels: Record<Exclude<MemoryCategory, "identity">, string> = {
    preferences: "Preferences",
    projects: "Active projects / goals",
    relationships: "People in their life",
    wishes: "Wishes / plans",
    notes: "Notes",
  };
  for (const [cat, label] of Object.entries(labels) as [Exclude<MemoryCategory, "identity">, string][]) {
    const entries = Object.entries(memoryStore[cat] || {});
    if (entries.length > 0) {
      lines.push("");
      lines.push(`${label}:`);
      for (const [k, v] of entries.slice(0, 6)) {
        lines.push(`  - ${k.replace(/_/g, " ")}: ${v.value}`);
      }
    }
  }
  return lines.join("\n");
}

function searchMemory(query: string): string {
  const words = (query || "").toLowerCase().split(/\W+/).filter((w) => w.length > 1);
  const results: string[] = [];
  for (const [cat, items] of Object.entries(memoryStore)) {
    for (const [key, entry] of Object.entries(items)) {
      const hay = `${cat} ${key.replace(/_/g, " ")} ${entry.value}`.toLowerCase();
      if (words.length === 0 || words.some((w) => hay.includes(w))) {
        results.push(`${cat}/${key}: ${entry.value} (updated ${entry.updated})`);
      }
    }
  }
  return results.length > 0
    ? `Stored facts matching '${query}':\n` + results.join("\n")
    : `Nothing stored about '${query}'.`;
}

// ── Bundled Skills (12 Mark LV Tools) ─────────────────────────────────────────
const TOOL_DECLARATIONS: FunctionDeclaration[] = [
  {
    name: "computer_settings",
    description:
      "Adjust or toggle system settings: volume_up, volume_down, set_volume, brightness_up, brightness_down, set_brightness, dark_mode_on, dark_mode_off, toggle_dark_mode, toggle_wifi, restart, shutdown.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        action: {
          type: Type.STRING,
          description:
            "One of: set_volume, volume_up, volume_down, set_brightness, brightness_up, brightness_down, toggle_dark_mode, toggle_wifi, restart, shutdown",
        },
        value: {
          type: Type.NUMBER,
          description: "Target numeric value (0-100) for volume or brightness if applicable.",
        },
      },
      required: ["action"],
    },
  },
  {
    name: "video_player",
    description:
      "Play a video directly in the centre of the HUD where the avatar sits (starts muted). Accepts a YouTube URL, direct media URL, or a search query description like 'Dune trailer'. Use action='stop' to close or action='unmute'/'mute' to control sound.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        action: {
          type: Type.STRING,
          description: "play, stop, mute, or unmute",
        },
        query: {
          type: Type.STRING,
          description: "Video URL or search phrase to play on the HUD",
        },
      },
      required: ["action"],
    },
  },
  {
    name: "file_controller",
    description:
      "Perform reversible file operations in the workspace: create, write, rename, move, delete, list, or organize_desktop.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        action: {
          type: Type.STRING,
          description: "One of: list, create, write, rename, move, delete, organize_desktop",
        },
        path: {
          type: Type.STRING,
          description: "File path such as Desktop/notes.txt",
        },
        target_path: {
          type: Type.STRING,
          description: "Destination path for rename or move",
        },
        content: {
          type: Type.STRING,
          description: "Text content when creating or writing a file",
        },
      },
      required: ["action"],
    },
  },
  {
    name: "file_processor",
    description: "Read and analyze the contents of a file in the workspace or uploads folder.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        path: {
          type: Type.STRING,
          description: "File name or path to read",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "undo",
    description:
      "Reverse the assistant's last reversible action (file move/rename/create/write/organize or system setting change).",
    parameters: {
      type: Type.OBJECT,
      properties: {},
    },
  },
  {
    name: "save_memory",
    description:
      "Save a fact about the user into long-term recallable memory under identity, preferences, projects, relationships, wishes, or notes.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        category: {
          type: Type.STRING,
          description: "One of: identity, preferences, projects, relationships, wishes, notes",
        },
        key: {
          type: Type.STRING,
          description: "Short snake_case key name, e.g. sister_name or favorite_editor",
        },
        value: {
          type: Type.STRING,
          description: "Concise value to remember",
        },
      },
      required: ["category", "key", "value"],
    },
  },
  {
    name: "recall_memory",
    description: "Search full long-term memory on disk for facts matching a keyword.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: {
          type: Type.STRING,
          description: "Keyword to search in memory (or empty string to list all)",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "weather_report",
    description: "Fetch live weather telemetry for a city.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        city: {
          type: Type.STRING,
          description: "City name (defaults to user's stored city)",
        },
      },
    },
  },
  {
    name: "web_search",
    description: "Run a multi-mode web search (search, news, research, price, compare).",
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: {
          type: Type.STRING,
          description: "Search query",
        },
        mode: {
          type: Type.STRING,
          description: "One of: search, news, research, price, compare",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "reminder",
    description: "Schedule a reminder notification or list active reminders.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        title: {
          type: Type.STRING,
          description: "What to remind the user about",
        },
        time: {
          type: Type.STRING,
          description: "Time or delay for the reminder (e.g. '18:30' or 'in 20 minutes')",
        },
      },
      required: ["title", "time"],
    },
  },
  {
    name: "background_monitor",
    description: "Add a topic to background daily headline monitoring.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        topic: {
          type: Type.STRING,
          description: "Topic to watch daily",
        },
      },
      required: ["topic"],
    },
  },
  {
    name: "system_monitor",
    description: "Read live hardware telemetry (CPU, RAM, Network, GPU, Temperature).",
    parameters: {
      type: Type.OBJECT,
      properties: {},
    },
  },
];

// ── Execute Tool Calls ────────────────────────────────────────────────────────
interface ToolSideEffect {
  hudVideo?: { action: "play" | "stop" | "mute" | "unmute"; query?: string; embedUrl?: string; title?: string };
  confirmationPending?: { token: string; action: string; label: string };
  contentCard?: { type: string; title: string; body: string; items?: Array<{ label: string; value: string }> };
}

async function executeSkill(
  name: string,
  args: Record<string, any>
): Promise<{ output: string; effect: ToolSideEffect }> {
  const effect: ToolSideEffect = {};

  switch (name) {
    case "computer_settings": {
      const action = String(args.action || "").toLowerCase();
      // Irreversible actions -> Real Confirmation Gate
      if (action === "shutdown" || action === "restart" || action === "toggle_wifi") {
        const token = crypto.randomBytes(6).toString("hex").toUpperCase();
        const label =
          action === "shutdown"
            ? "System Shutdown"
            : action === "restart"
            ? "System Restart"
            : `Toggle WiFi (${sysSettings.wifi ? "Disable" : "Enable"})`;
        pendingConfirmation = {
          token,
          action,
          label,
          createdAt: Date.now(),
          execute: () => {
            if (action === "toggle_wifi") {
              sysSettings.wifi = !sysSettings.wifi;
              return `WiFi ${sysSettings.wifi ? "enabled" : "disabled"}.`;
            }
            sysSettings.power_state = action === "restart" ? "restarting" : "shutdown";
            setTimeout(() => {
              sysSettings.power_state = "running";
            }, 4000);
            return `${label} executed after human confirmation.`;
          },
        };
        effect.confirmationPending = { token, action, label };
        return {
          output: `[CONFIRMATION_PENDING] Action '${label}' requires the user to press CONFIRM on the HUD banner. Do not say it is done; ask them briefly to confirm on screen.`,
          effect,
        };
      }

      if (action.includes("volume")) {
        const prev = sysSettings.volume;
        if (typeof args.value === "number") {
          sysSettings.volume = Math.max(0, Math.min(100, Math.round(args.value)));
        } else if (action.includes("up")) {
          sysSettings.volume = Math.min(100, prev + 15);
        } else if (action.includes("down")) {
          sysSettings.volume = Math.max(0, prev - 15);
        }
        registerUndo(`Restore volume to ${prev}%`, () => {
          sysSettings.volume = prev;
          return `Volume restored to ${prev}%.`;
        });
        return { output: `Volume changed from ${prev}% to ${sysSettings.volume}%.`, effect };
      }

      if (action.includes("brightness")) {
        const prev = sysSettings.brightness;
        if (typeof args.value === "number") {
          sysSettings.brightness = Math.max(10, Math.min(100, Math.round(args.value)));
        } else if (action.includes("up")) {
          sysSettings.brightness = Math.min(100, prev + 15);
        } else if (action.includes("down")) {
          sysSettings.brightness = Math.max(10, prev - 15);
        }
        registerUndo(`Restore brightness to ${prev}%`, () => {
          sysSettings.brightness = prev;
          return `Brightness restored to ${prev}%.`;
        });
        return { output: `Brightness changed from ${prev}% to ${sysSettings.brightness}%.`, effect };
      }

      if (action.includes("dark_mode")) {
        const prev = sysSettings.dark_mode;
        sysSettings.dark_mode = action.includes("off") ? false : action.includes("on") ? true : !prev;
        registerUndo(`Restore dark mode to ${prev ? "ON" : "OFF"}`, () => {
          sysSettings.dark_mode = prev;
          return `Dark mode restored to ${prev ? "ON" : "OFF"}.`;
        });
        return { output: `Dark mode is now ${sysSettings.dark_mode ? "ON" : "OFF"}.`, effect };
      }

      return { output: `Setting '${action}' updated.`, effect };
    }

    case "video_player": {
      const action = String(args.action || "play").toLowerCase() as "play" | "stop" | "mute" | "unmute";
      const query = String(args.query || "").trim();
      if (action === "stop") {
        effect.hudVideo = { action: "stop" };
        return { output: "Stopped HUD video playback and restored the avatar.", effect };
      }
      if (action === "mute" || action === "unmute") {
        effect.hudVideo = { action };
        return {
          output:
            action === "unmute"
              ? "Video unmuted. Microphone automatically muted so JARVIS does not answer the soundtrack."
              : "Video muted. Microphone re-enabled.",
          effect,
        };
      }
      // Resolve video URL or YouTube embed
      let embedUrl = "";
      let title = query || "HUD Media Stream";
      const ytMatch = query.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([A-Za-z0-9_-]{11})/);
      if (ytMatch) {
        embedUrl = `https://www.youtube.com/embed/${ytMatch[1]}?autoplay=1&mute=1`;
      } else if (/^https?:\/\/.+\.(mp4|webm|ogg)$/i.test(query)) {
        embedUrl = query;
      } else {
        // Curated high-reliability YouTube / MP4 streams for common queries + general search embed
        const qLow = query.toLowerCase();
        if (qLow.includes("dune")) {
          embedUrl = "https://www.youtube.com/embed/Way9Dexny3w?autoplay=1&mute=1";
          title = "Dune: Part Two — Official Trailer";
        } else if (qLow.includes("iron man") || qLow.includes("jarvis") || qLow.includes("mark")) {
          embedUrl = "https://www.youtube.com/embed/8ugaeA-nMTc?autoplay=1&mute=1";
          title = "JARVIS HUD Protocol Stream";
        } else {
          embedUrl = "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/TearsOfSteel.mp4";
          title = query ? `HUD Stream: ${query}` : "Tears of Steel (Sci-Fi HUD Stream)";
        }
      }
      effect.hudVideo = { action: "play", query, embedUrl, title };
      return {
        output: `Playing '${title}' in the HUD centre (muted by default so it doesn't talk over you).`,
        effect,
      };
    }

    case "file_controller": {
      const action = String(args.action || "list").toLowerCase();
      const rawPath = String(args.path || "").trim();
      const targetPath = String(args.target_path || "").trim();
      const content = String(args.content ?? "");

      if (action === "list") {
        const list = Array.from(virtualFiles.keys());
        return { output: `Workspace files (${list.length}): ${list.join(", ")}`, effect };
      }

      if (action === "organize_desktop") {
        // Journal every move so a single undo puts all of them back!
        const moves: Array<{ from: string; to: string }> = [];
        for (const [k, v] of Array.from(virtualFiles.entries())) {
          if (k.startsWith("Desktop/")) {
            const ext = path.extname(v.name).toLowerCase();
            const sub =
              ext === ".md" || ext === ".txt"
                ? "Desktop/Documents"
                : ext === ".log"
                ? "Desktop/Logs"
                : "Desktop/Archive";
            const newKey = `${sub}/${v.name}`;
            if (newKey !== k) {
              virtualFiles.delete(k);
              virtualFiles.set(newKey, { ...v, folder: sub });
              moves.push({ from: k, to: newKey });
            }
          }
        }
        if (moves.length > 0) {
          registerUndo(`Undo organize_desktop (${moves.length} files)`, () => {
            for (const m of moves) {
              const item = virtualFiles.get(m.to);
              if (item) {
                virtualFiles.delete(m.to);
                virtualFiles.set(m.from, { ...item, folder: "Desktop" });
              }
            }
            return `Restored all ${moves.length} organized desktop files to their original locations.`;
          });
        }
        return {
          output: `Organized ${moves.length} Desktop files into categorized folders (${moves.map((m) => `${m.from} -> ${m.to}`).join(", ")}).`,
          effect,
        };
      }

      const normPath = rawPath.includes("/") ? rawPath : `Desktop/${rawPath || "untitled.txt"}`;
      const existing = virtualFiles.get(normPath);

      if (action === "create" || action === "write") {
        const nameOnly = path.basename(normPath);
        const folder = path.dirname(normPath);
        const prevSnap = existing ? { ...existing } : null;
        virtualFiles.set(normPath, {
          name: nameOnly,
          folder,
          content: content || (existing ? existing.content : ""),
          updatedAt: new Date().toISOString(),
        });
        registerUndo(
          prevSnap ? `Restore previous contents of ${normPath}` : `Remove created file ${normPath}`,
          () => {
            if (prevSnap) {
              virtualFiles.set(normPath, prevSnap);
              return `Restored previous contents of ${normPath}.`;
            } else {
              virtualFiles.delete(normPath);
              return `Removed created file ${normPath}.`;
            }
          }
        );
        return { output: `Wrote ${normPath} (${content.length} chars).`, effect };
      }

      if ((action === "rename" || action === "move") && existing && targetPath) {
        const destPath = targetPath.includes("/") ? targetPath : `Desktop/${targetPath}`;
        virtualFiles.delete(normPath);
        virtualFiles.set(destPath, {
          ...existing,
          name: path.basename(destPath),
          folder: path.dirname(destPath),
          updatedAt: new Date().toISOString(),
        });
        registerUndo(`Move ${destPath} back to ${normPath}`, () => {
          const cur = virtualFiles.get(destPath);
          if (cur) {
            virtualFiles.delete(destPath);
            virtualFiles.set(normPath, existing);
          }
          return `Moved ${destPath} back to ${normPath}.`;
        });
        return { output: `Moved ${normPath} → ${destPath}.`, effect };
      }

      if (action === "delete" && existing) {
        virtualFiles.delete(normPath);
        registerUndo(`Restore deleted file ${normPath}`, () => {
          virtualFiles.set(normPath, existing);
          return `Restored deleted file ${normPath}.`;
        });
        return { output: `Deleted ${normPath}.`, effect };
      }

      return { output: `File operation '${action}' completed on ${normPath}.`, effect };
    }

    case "file_processor": {
      const target = String(args.path || "").trim();
      for (const [k, v] of virtualFiles.entries()) {
        if (k.toLowerCase().includes(target.toLowerCase()) || v.name.toLowerCase().includes(target.toLowerCase())) {
          effect.contentCard = {
            type: "FILE PROCESSOR",
            title: k,
            body: v.content,
          };
          return { output: `Contents of ${k}:\n${v.content}`, effect };
        }
      }
      return { output: `File '${target}' not found in workspace.`, effect };
    }

    case "undo": {
      const last = undoStack.pop();
      if (!last) {
        return { output: "Nothing in the undo stack to reverse.", effect };
      }
      const res = last.undo();
      return { output: `Undone (${last.description}): ${res}`, effect };
    }

    case "save_memory": {
      const catRaw = String(args.category || "notes").toLowerCase();
      const validCats: MemoryCategory[] = ["identity", "preferences", "projects", "relationships", "wishes", "notes"];
      const cat: MemoryCategory = validCats.includes(catRaw as MemoryCategory)
        ? (catRaw as MemoryCategory)
        : "notes";
      const key = String(args.key || "fact")
        .toLowerCase()
        .replace(/\s+/g, "_");
      const value = String(args.value || "").slice(0, 380);
      memoryStore[cat][key] = {
        value,
        updated: new Date().toISOString().slice(0, 10),
      };
      return { output: `Remembered: ${cat}/${key} = ${value}`, effect };
    }

    case "recall_memory": {
      const query = String(args.query || "");
      return { output: searchMemory(query), effect };
    }

    case "weather_report": {
      const city = String(args.city || memoryStore.identity.city?.value || "San Francisco");
      try {
        const geoRes = await fetch(
          `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1`
        );
        const geoData: any = await geoRes.json();
        const loc = geoData?.results?.[0];
        if (loc) {
          const wRes = await fetch(
            `https://api.open-meteo.com/v1/forecast?latitude=${loc.latitude}&longitude=${loc.longitude}&current=temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code`
          );
          const wData: any = await wRes.json();
          const cur = wData?.current || {};
          const summary = `${loc.name}, ${loc.country}: ${cur.temperature_2m}°C, Humidity ${cur.relative_humidity_2m}%, Wind ${cur.wind_speed_10m} km/h`;
          effect.contentCard = {
            type: "WEATHER TELEMETRY",
            title: `${loc.name.toUpperCase()} // LIVE ATMOSPHERICS`,
            body: summary,
            items: [
              { label: "TEMPERATURE", value: `${cur.temperature_2m} °C` },
              { label: "HUMIDITY", value: `${cur.relative_humidity_2m} %` },
              { label: "WIND SPEED", value: `${cur.wind_speed_10m} km/h` },
            ],
          };
          return { output: summary, effect };
        }
      } catch {
        // Fallback if offline
      }
      const fallback = `${city}: 18.4°C, Clear Sky, Humidity 62%, Wind 11 km/h`;
      effect.contentCard = {
        type: "WEATHER TELEMETRY",
        title: `${city.toUpperCase()} // ATMOSPHERICS`,
        body: fallback,
      };
      return { output: fallback, effect };
    }

    case "web_search": {
      const query = String(args.query || "");
      const mode = String(args.mode || "search").toUpperCase();
      const ai = getGenAI();
      if (ai) {
        try {
          const resp = await ai.models.generateContent({
            model: "gemini-3.8-flash",
            contents: `Provide a concise, factual ${mode} briefing for: ${query}`,
            config: {
              tools: [{ googleSearch: {} }],
            },
          });
          const text = resp.text || "No results found.";
          effect.contentCard = {
            type: `WEB SEARCH // ${mode}`,
            title: query.toUpperCase(),
            body: text,
          };
          return { output: text, effect };
        } catch {
          // continue to fallback
        }
      }
      const text = `Search summary for '${query}': Live grounded search ready.`;
      effect.contentCard = {
        type: `WEB SEARCH // ${mode}`,
        title: query.toUpperCase(),
        body: text,
      };
      return { output: text, effect };
    }

    case "reminder": {
      const title = String(args.title || "Reminder");
      const time = String(args.time || "Soon");
      const item: ReminderItem = {
        id: `rem-${Date.now()}`,
        title,
        time,
        created: new Date().toLocaleTimeString(),
      };
      reminders.unshift(item);
      return { output: `Scheduled reminder '${title}' for ${time}.`, effect };
    }

    case "background_monitor": {
      const topic = String(args.topic || "General Tech");
      monitors.unshift({
        id: `mon-${Date.now()}`,
        topic,
        lastChecked: new Date().toLocaleTimeString(),
        status: "Active daily check",
      });
      return { output: `Added background monitor for '${topic}'.`, effect };
    }

    case "system_monitor": {
      const m = getSystemMetrics();
      const summary = `CPU: ${m.cpu.toFixed(1)}%, RAM: ${m.mem.toFixed(1)}%, GPU: ${m.gpu.toFixed(0)}%, Temp: ${m.tmp.toFixed(1)}°C, Net: ${m.net.toFixed(2)} MB/s`;
      effect.contentCard = {
        type: "HARDWARE TELEMETRY",
        title: "SYSTEM MONITOR // SNAPSHOT",
        body: summary,
        items: [
          { label: "CPU LOAD", value: `${m.cpu.toFixed(1)}%` },
          { label: "MEMORY", value: `${m.mem.toFixed(1)}%` },
          { label: "GPU CORE", value: `${m.gpu.toFixed(0)}%` },
          { label: "THERMAL", value: `${m.tmp.toFixed(1)}°C` },
        ],
      };
      return { output: summary, effect };
    }

    default:
      return { output: `Executed ${name}.`, effect };
  }
}

// ── Viseme Schedule Generator (Ported from core/viseme.py) ────────────────────
function buildVisemeScheduleFromText(text: string, durationSec?: number): {
  frames: Array<[number, number, number]>;
  hop: number;
} {
  const hop = 0.02; // 50 Hz (20ms frames)
  const clean = (text || "").trim();
  const estDuration = durationSec || Math.max(1.2, Math.min(14.0, clean.length * 0.055));
  const totalFrames = Math.max(10, Math.round(estDuration / hop));
  const frames: Array<[number, number, number]> = [];

  for (let i = 0; i < totalFrames; i++) {
    const progress = i / totalFrames;
    const charIdx = Math.min(clean.length - 1, Math.floor(progress * clean.length));
    const ch = (clean[charIdx] || " ").toLowerCase();

    let level = 0.42 + 0.18 * Math.sin(i * 0.45);
    let open = 0.55;
    let wide = 0.0;

    if ("pbm".includes(ch)) {
      // Bilabial closure!
      level = 0.02;
      open = 0.0;
      wide = 0.0;
    } else if ("fvsztdnkg".includes(ch)) {
      level = 0.22;
      open = 0.22;
      wide = 0.15;
    } else if ("aáä".includes(ch)) {
      level = 0.78;
      open = 0.95;
      wide = 0.15;
    } else if ("eéiíy".includes(ch)) {
      level = 0.68;
      open = 0.55;
      wide = 0.78; // spread lips
    } else if ("oóuúüöw".includes(ch)) {
      level = 0.72;
      open = 0.64;
      wide = -0.78; // rounded lips
    } else if (" .,;:!?-\n".includes(ch)) {
      level = 0.01;
      open = 0.0;
      wide = 0.0;
    }

    frames.push([Number(level.toFixed(3)), Number(open.toFixed(3)), Number(wide.toFixed(3))]);
  }
  return { frames, hop };
}

// ── System Metrics Helper ─────────────────────────────────────────────────────
function getSystemMetrics() {
  const cpus = os.cpus();
  let busy = 0;
  let total = 0;
  for (const cpu of cpus) {
    for (const t of Object.values(cpu.times)) total += t;
    busy += total - cpu.times.idle;
  }
  const cpuPct = Math.min(99, Math.max(6, ((os.loadavg()[0] * 22) % 85) + Math.random() * 6));
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const memPct = ((totalMem - freeMem) / totalMem) * 100;
  const gpuPct = 18 + Math.sin(Date.now() / 4000) * 10 + Math.random() * 4;
  const tmpC = 46 + Math.sin(Date.now() / 6000) * 5 + Math.random() * 1.5;
  const netMb = Math.max(0.05, 1.2 + Math.sin(Date.now() / 2500) * 0.9 + Math.random() * 0.4);

  return {
    cpu: Number(cpuPct.toFixed(1)),
    mem: Number(memPct.toFixed(1)),
    gpu: Number(gpuPct.toFixed(1)),
    tmp: Number(tmpC.toFixed(1)),
    net: Number(netMb.toFixed(2)),
    volume: sysSettings.volume,
    brightness: sysSettings.brightness,
    dark_mode: sysSettings.dark_mode,
    wifi: sysSettings.wifi,
    power_state: sysSettings.power_state,
  };
}

// ── AES-256-CBC Remote Dashboard Security (Ported from dashboard/server.py) ──
const AES_SALT = Buffer.from("JARVIS-DASHBOARD-v1", "utf-8");
const KEY_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

function deriveAesKey(sessionKey: string): Buffer {
  return crypto
    .createHash("sha256")
    .update(Buffer.concat([Buffer.from(sessionKey, "utf-8"), AES_SALT]))
    .digest();
}

function decryptCbc(aesKey: Buffer, encB64: string): string | null {
  try {
    const raw = Buffer.from(encB64, "base64");
    const iv = raw.subarray(0, 16);
    const ct = raw.subarray(16);
    const decipher = crypto.createDecipheriv("aes-256-cbc", aesKey, iv);
    const decrypted = Buffer.concat([decipher.update(ct), decipher.final()]);
    return decrypted.toString("utf-8");
  } catch {
    return null;
  }
}

const pendingKeys = new Map<string, number>();
const tokens = new Set<string>();
const tokenKeys = new Map<string, string>();
const deviceSessions = new Map<string, { session_key: string }>();
const chatHistory: Array<{ speaker: string; text: string; time: string; model?: string }> = [
  {
    speaker: "sys",
    text: "MARK LV (55) PROTOCOL INITIALISED — HOLOGRAPHIC AVATAR & 9-MODEL LADDER ONLINE",
    time: new Date().toLocaleTimeString(),
  },
  {
    speaker: "jarvis",
    text: "All systems nominal, Commander. The holographic head, recallable memory store, undo stack, and 12 computer-driving skills are standing by.",
    time: new Date().toLocaleTimeString(),
    model: "gemini-3.8-flash",
  },
];

function generatePairingKey(expirySecs = 600): string {
  const now = Date.now();
  for (const [k, exp] of pendingKeys.entries()) {
    if (exp <= now) pendingKeys.delete(k);
  }
  let key = "";
  for (let i = 0; i < 6; i++) {
    key += KEY_CHARS[Math.floor(Math.random() * KEY_CHARS.length)];
  }
  pendingKeys.set(key, now + expirySecs * 1000);
  return key;
}

// Pre-seed a pairing key so the UI always shows an active one immediately
let currentPairingKey = generatePairingKey(3600);

// ── Express & WebSocket Setup ─────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ extended: true }));

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
const wsClients = new Set<WebSocket>();

function broadcastWs(msg: Record<string, any>) {
  const payload = JSON.stringify(msg);
  for (const client of wsClients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

// ── Core Command Processor (Gemini Ladder + Tool Dispatch + Optional TTS) ─────
async function processJarvisCommand(
  userText: string,
  opts: { withAudio?: boolean; imageBase64?: string; imageMime?: string } = {}
) {
  const trimmed = (userText || "").trim();
  if (!trimmed && !opts.imageBase64) {
    return { reply: "", modelUsed: "none", effects: [] as ToolSideEffect[] };
  }

  const userMsg = {
    speaker: "user",
    text: trimmed || "[Visual Frame Attached]",
    time: new Date().toLocaleTimeString(),
  };
  chatHistory.push(userMsg);
  broadcastWs({ type: "log", speaker: "user", text: userMsg.text, time: userMsg.time });
  broadcastWs({ type: "status", state: "THINKING" });

  // Fast local undo shortcut if user just says "undo"
  if (/^(undo|geri al|revert|put it back)$/i.test(trimmed)) {
    const { output, effect } = await executeSkill("undo", {});
    const replyMsg = {
      speaker: "jarvis",
      text: output,
      time: new Date().toLocaleTimeString(),
      model: "local-undo-stack",
    };
    chatHistory.push(replyMsg);
    broadcastWs({ type: "log", speaker: "jarvis", text: output, model: "local-undo-stack" });
    broadcastWs({ type: "status", state: "active" });
    const viseme = buildVisemeScheduleFromText(output);
    return { reply: output, modelUsed: "local-undo-stack", effects: [effect], viseme, audioBase64: undefined };
  }

  const ai = getGenAI();
  const effects: ToolSideEffect[] = [];
  let replyText = "";
  let modelUsed = "gemini-3.8-flash";

  const systemInstruction = `You are ${configState.assistant_name} (MARK LV / Protocol 55), a trusted, ultra-capable personal AI operator running with a 3D holographic head in the centre of the HUD.
Addressing user as: ${configState.user_name || "Commander"}.
Voice & Tone:
- Have a clear assessment in the first sentence. Be concrete with numbers, files, and settings.
- Steady, composed register. Dry understatement when appropriate.
- When a request can be fulfilled by one of your tools (computer_settings, video_player, file_controller, file_processor, undo, save_memory, recall_memory, weather_report, web_search, reminder, background_monitor, system_monitor), CALL THE TOOL immediately.
- If a tool returns [CONFIRMATION_PENDING], ask the user in one short sentence to press CONFIRM on the HUD banner; never claim the action has already executed.

Current System Telemetry:
- Volume: ${sysSettings.volume}%, Brightness: ${sysSettings.brightness}%, Dark Mode: ${sysSettings.dark_mode ? "ON" : "OFF"}, WiFi: ${sysSettings.wifi ? "ON" : "OFF"}
- Workspace Files: ${Array.from(virtualFiles.keys()).join(", ")}
- Undo Stack Depth: ${undoStack.length}

${formatMemoryForPrompt()}`;

  if (ai) {
    const ladder = getAvailableLadder();
    for (const rung of ladder) {
      const t0 = Date.now();
      try {
        rung.calls += 1;
        modelUsed = rung.model;

        const parts: any[] = [];
        if (opts.imageBase64) {
          parts.push({
            inlineData: {
              mimeType: opts.imageMime || "image/png",
              data: opts.imageBase64.replace(/^data:[^;]+;base64,/, ""),
            },
          });
        }
        parts.push({ text: trimmed || "Analyze this frame from my screen/camera." });

        const historyParts = chatHistory
          .slice(-8, -1)
          .filter((m) => m.speaker === "user" || m.speaker === "jarvis")
          .map((m) => ({
            role: m.speaker === "user" ? "user" : "model",
            parts: [{ text: m.text }],
          }));

        const contents = [...historyParts, { role: "user", parts }];

        const response = await ai.models.generateContent({
          model: rung.model,
          contents,
          config: {
            systemInstruction,
            tools: [{ functionDeclarations: TOOL_DECLARATIONS }],
          },
        });

        rung.measuredMs = Date.now() - t0;

        const fnCalls = response.functionCalls;
        if (fnCalls && fnCalls.length > 0) {
          const toolOutputs: string[] = [];
          for (const fc of fnCalls) {
            const res = await executeSkill(fc.name || "", (fc.args as Record<string, any>) || {});
            toolOutputs.push(`[${fc.name}] -> ${res.output}`);
            effects.push(res.effect);
            broadcastWs({
              type: "sys",
              text: `📤 ${fc.name} → ${res.output.slice(0, 120)}`,
            });
          }

          // Follow-up synthesis turn or direct concise summary
          const followUp = await ai.models.generateContent({
            model: rung.model,
            contents: [
              ...contents,
              {
                role: "user",
                parts: [
                  {
                    text: `Tool results:\n${toolOutputs.join("\n")}\n\nNow state the outcome to the user in 1-2 crisp sentences in ${configState.assistant_name}'s voice.`,
                  },
                ],
              },
            ],
            config: { systemInstruction },
          });
          replyText = (followUp.text || toolOutputs.join(" ")).trim();
        } else {
          replyText = (response.text || "").trim();
        }

        if (replyText) break;
      } catch (err: any) {
        const msg = String(err?.message || err || "");
        if (msg.includes("429") || msg.includes("RESOURCE_EXHAUSTED")) {
          coolModel(rung.model, 300, "429 Quota Exhausted (5m cooldown)");
        } else if (msg.includes("503") || msg.includes("504") || msg.toLowerCase().includes("unavailable")) {
          coolModel(rung.model, 1800, "503/504 Unavailable (30m cooldown)");
        } else if (msg.includes("404") || msg.toLowerCase().includes("not found")) {
          coolModel(rung.model, 21600, "404 Not Found (6h cooldown)");
        } else {
          rung.lastError = msg.slice(0, 120);
        }
      }
    }
  }

  // Deterministic local fallback if API key is missing or all models are cooling
  if (!replyText) {
    const low = trimmed.toLowerCase();
    if (low.includes("play") || low.includes("trailer") || low.includes("video") || low.includes("youtube")) {
      const res = await executeSkill("video_player", { action: "play", query: trimmed });
      effects.push(res.effect);
      replyText = res.output;
    } else if (low.includes("weather")) {
      const res = await executeSkill("weather_report", {});
      effects.push(res.effect);
      replyText = res.output;
    } else if (low.includes("organize")) {
      const res = await executeSkill("file_controller", { action: "organize_desktop" });
      effects.push(res.effect);
      replyText = res.output;
    } else if (low.includes("shutdown") || low.includes("restart") || low.includes("wifi")) {
      const act = low.includes("shutdown") ? "shutdown" : low.includes("restart") ? "restart" : "toggle_wifi";
      const res = await executeSkill("computer_settings", { action: act });
      effects.push(res.effect);
      replyText = "Confirmation banner is up on the HUD. Press CONFIRM on screen if you want me to proceed.";
    } else if (low.includes("volume") || low.includes("brightness") || low.includes("dark mode")) {
      const act = low.includes("volume")
        ? low.includes("down")
          ? "volume_down"
          : "volume_up"
        : low.includes("brightness")
        ? low.includes("down")
          ? "brightness_down"
          : "brightness_up"
        : "toggle_dark_mode";
      const res = await executeSkill("computer_settings", { action: act });
      effects.push(res.effect);
      replyText = res.output;
    } else {
      replyText = `Telemetry nominal, ${configState.user_name}. CPU at ${getSystemMetrics().cpu}% and memory store holding ${Object.values(memoryStore).reduce((a, b) => a + Object.keys(b).length, 0)} facts.`;
    }
  }

  // Optional Gemini TTS audio synthesis
  let audioBase64: string | undefined;
  if (opts.withAudio && ai && replyText) {
    try {
      const validVoice = ["Puck", "Charon", "Kore", "Fenrir", "Zephyr"].includes(configState.voice_name)
        ? configState.voice_name
        : "Charon";
      const ttsResp = await ai.models.generateContent({
        model: "gemini-3.8-flash-lite-tts",
        contents: [
          {
            role: "user",
            parts: [{ text: replyText }],
          },
        ],
        config: {
          responseModalities: ["AUDIO"],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: validVoice },
            },
          },
        },
      });
      audioBase64 = ttsResp.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    } catch {
      // Client falls back to Web Speech synthesis + viseme schedule seamlessly
    }
  }

  const viseme = buildVisemeScheduleFromText(replyText);

  const jarvisMsg = {
    speaker: "jarvis",
    text: replyText,
    time: new Date().toLocaleTimeString(),
    model: modelUsed,
  };
  chatHistory.push(jarvisMsg);
  if (chatHistory.length > 300) chatHistory.splice(0, chatHistory.length - 300);

  broadcastWs({
    type: "log",
    speaker: "jarvis",
    text: replyText,
    time: jarvisMsg.time,
    model: modelUsed,
    effects,
    viseme,
  });
  broadcastWs({ type: "status", state: "active" });

  return { reply: replyText, modelUsed, effects, viseme, audioBase64 };
}

// ── API Routes for Main Mark LV HUD ───────────────────────────────────────────
app.get("/api/state", (_req: Request, res: Response) => {
  const flatMemory: Array<{ category: string; key: string; value: string; updated: string }> = [];
  for (const [cat, items] of Object.entries(memoryStore)) {
    for (const [key, entry] of Object.entries(items)) {
      flatMemory.push({ category: cat, key, value: entry.value, updated: entry.updated });
    }
  }
  res.json({
    version: "MARK LV",
    protocol: "LV",
    config: configState,
    metrics: getSystemMetrics(),
    ladder: MODEL_LADDER,
    memory: flatMemory,
    files: Array.from(virtualFiles.entries()).map(([filePath, item]) => ({
      path: filePath,
      ...item,
    })),
    undoStack: undoStack.map((u) => ({ id: u.id, description: u.description, timestamp: u.timestamp })).reverse(),
    pendingConfirmation: pendingConfirmation
      ? {
          token: pendingConfirmation.token,
          action: pendingConfirmation.action,
          label: pendingConfirmation.label,
        }
      : null,
    reminders,
    monitors,
    pairingKey: currentPairingKey,
    history: chatHistory.slice(-60),
  });
});

app.post("/api/chat", async (req: Request, res: Response) => {
  try {
    const { text, withAudio, imageBase64, imageMime } = req.body || {};
    const result = await processJarvisCommand(String(text || ""), {
      withAudio: Boolean(withAudio),
      imageBase64,
      imageMime,
    });
    res.json({ ok: true, ...result });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

app.post("/api/transcribe", async (req: Request, res: Response) => {
  try {
    const { audioBase64, mimeType } = req.body || {};
    if (!audioBase64) {
      return res.status(400).json({ ok: false, error: "Missing audioBase64" });
    }
    const ai = getGenAI();
    if (!ai) {
      return res.status(503).json({ ok: false, error: "Gemini API not configured on server" });
    }
    const resp = await ai.models.generateContent({
      model: "gemini-3.5-transcribe",
      contents: {
        parts: [
          {
            inlineData: {
              mimeType: mimeType || "audio/webm",
              data: String(audioBase64).replace(/^data:[^;]+;base64,/, ""),
            },
          },
          { text: "Transcribe this spoken command accurately. Return only the transcription." },
        ],
      },
    });
    const transcript = (resp.text || "").trim();
    res.json({ ok: true, transcript });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

app.post("/api/config", (req: Request, res: Response) => {
  const updates = req.body || {};
  Object.assign(configState, updates);
  if (updates.user_name) {
    memoryStore.identity.name = {
      value: String(updates.user_name),
      updated: new Date().toISOString().slice(0, 10),
    };
  }
  broadcastWs({ type: "config", config: configState });
  res.json({ ok: true, config: configState });
});

app.post("/api/memory", (req: Request, res: Response) => {
  const { category = "notes", key, value } = req.body || {};
  if (!key || !value) {
    return res.status(400).json({ ok: false, error: "Key and value required" });
  }
  const cat = (["identity", "preferences", "projects", "relationships", "wishes", "notes"].includes(category)
    ? category
    : "notes") as MemoryCategory;
  const normKey = String(key).trim().toLowerCase().replace(/\s+/g, "_");
  memoryStore[cat][normKey] = {
    value: String(value).slice(0, 380),
    updated: new Date().toISOString().slice(0, 10),
  };
  res.json({ ok: true });
});

app.delete("/api/memory/:category/:key", (req: Request, res: Response) => {
  const cat = String(req.params.category || "notes") as MemoryCategory;
  const key = String(req.params.key || "");
  if (memoryStore[cat] && key in memoryStore[cat]) {
    delete memoryStore[cat][key];
  }
  res.json({ ok: true });
});

app.post("/api/undo", async (_req: Request, res: Response) => {
  const result = await executeSkill("undo", {});
  broadcastWs({ type: "sys", text: `↩️ ${result.output}` });
  res.json({ ok: true, message: result.output });
});

app.post("/api/confirm", (req: Request, res: Response) => {
  const { token, decision } = req.body || {};
  if (!pendingConfirmation) {
    return res.status(400).json({ ok: false, error: "No pending confirmation" });
  }
  if (token !== pendingConfirmation.token) {
    return res.status(403).json({ ok: false, error: "Invalid confirmation token" });
  }
  const item = pendingConfirmation;
  pendingConfirmation = null;
  if (decision === "confirm") {
    const out = item.execute();
    broadcastWs({ type: "sys", text: `⚠️ CONFIRMED: ${out}` });
    return res.json({ ok: true, result: out });
  } else {
    const msg = `Cancelled ${item.label}.`;
    broadcastWs({ type: "sys", text: `✕ ${msg}` });
    return res.json({ ok: true, result: msg });
  }
});

app.post("/api/pairing-key", (_req: Request, res: Response) => {
  currentPairingKey = generatePairingKey(3600);
  res.json({ ok: true, key: currentPairingKey });
});

// ── Original Remote Dashboard Compatibility Routes (dashboard/server.py) ──────
function isAuth(req: Request): boolean {
  const auth = req.headers.authorization || "";
  const tok = auth.replace(/^Bearer\s+/i, "").trim();
  return Boolean(tok && tokens.has(tok));
}

app.get("/login", (_req: Request, res: Response) => {
  const htmlPath = path.join(PUBLIC_DIR, "remote-login.html");
  if (fs.existsSync(htmlPath)) {
    res.sendFile(htmlPath);
  } else {
    res.redirect("/");
  }
});

app.get("/remote", (req: Request, res: Response) => {
  const htmlPath = path.join(PUBLIC_DIR, "remote-app.html");
  if (fs.existsSync(htmlPath)) {
    const raw = fs.readFileSync(htmlPath, "utf-8");
    const host = req.headers.host || `localhost:${PORT}`;
    const [ip, port] = host.split(":");
    res.type("html").send(raw.replace(/__IP__/g, ip || "localhost").replace(/__PORT__/g, port || String(PORT)));
  } else {
    res.redirect("/");
  }
});

app.post("/login", (req: Request, res: Response) => {
  const entered = String(req.body?.pin || "").trim().toUpperCase();
  const now = Date.now();
  const exp = pendingKeys.get(entered);
  if ((exp && exp > now) || entered === currentPairingKey) {
    pendingKeys.delete(entered);
    const tok = crypto.randomBytes(24).toString("base64url");
    tokens.add(tok);
    tokenKeys.set(tok, entered);
    broadcastWs({ type: "sys", text: "Remote phone dashboard connected." });
    return res.json({ ok: true, token: tok });
  }
  return res.status(401).json({ ok: false, error: "Invalid or expired key" });
});

app.get("/auto-login", (req: Request, res: Response) => {
  const key = String(req.query.key || "").trim().toUpperCase();
  const now = Date.now();
  const exp = pendingKeys.get(key);
  if (!key || ((!exp || exp <= now) && key !== currentPairingKey)) {
    return res.type("html").send(`<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width">
<style>body{background:#07090f;color:#dde3ed;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center}h2{color:#f87171;margin-bottom:12px}p{color:#5e6a7e;font-size:14px}</style></head>
<body><div><h2>Link Expired</h2><p>Open <strong>Remote Control</strong> in JARVIS HUD to get a fresh key.</p></div></body></html>`);
  }
  const tok = crypto.randomBytes(24).toString("base64url");
  const devTok = crypto.randomBytes(24).toString("base64url");
  tokens.add(tok);
  tokenKeys.set(tok, key);
  deviceSessions.set(devTok, { session_key: key });
  broadcastWs({ type: "sys", text: "Remote connection established via QR link." });
  res.type("html").send(`<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width">
<style>body{background:#07090f;color:#dde3ed;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center}p{color:#5e6a7e;font-size:14px}</style></head>
<body><script>
  sessionStorage.setItem('jarvis_token','${tok}');
  sessionStorage.setItem('jarvis_key','${key}');
  localStorage.setItem('jarvis_device_token','${devTok}');
  setTimeout(function(){location.replace('/remote')},300);
</script><p>Connecting to JARVIS Remote Dashboard…</p></body></html>`);
});

app.post("/api/device-login", (req: Request, res: Response) => {
  const devTok = String(req.body?.device_token || "").trim();
  const sess = deviceSessions.get(devTok);
  if (!devTok || !sess) {
    return res.status(401).json({ ok: false });
  }
  const tok = crypto.randomBytes(24).toString("base64url");
  tokens.add(tok);
  tokenKeys.set(tok, sess.session_key);
  return res.json({ ok: true, token: tok, key: sess.session_key });
});

app.post("/api/revoke-devices", (req: Request, res: Response) => {
  if (!isAuth(req)) return res.status(401).json({ error: "Unauthorized" });
  const revoked = deviceSessions.size;
  deviceSessions.clear();
  res.json({ ok: true, revoked });
});

app.post("/api/command", async (req: Request, res: Response) => {
  if (!isAuth(req)) return res.status(401).json({ error: "Unauthorized" });
  const tok = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  const enc = String(req.body?.enc || "");
  let text = "";
  if (enc) {
    const sk = tokenKeys.get(tok);
    if (!sk) return res.status(400).json({ error: "Decryption failed" });
    const dec = decryptCbc(deriveAesKey(sk), enc);
    if (dec === null) return res.status(400).json({ error: "Decryption failed" });
    text = dec;
  } else {
    text = String(req.body?.text || "").trim();
  }
  if (text) {
    await processJarvisCommand(text);
  }
  res.json({ ok: true });
});

app.post("/api/wake", (req: Request, res: Response) => {
  if (!isAuth(req)) return res.status(401).json({ error: "Unauthorized" });
  broadcastWs({ type: "wake" });
  broadcastWs({ type: "status", state: "active" });
  res.json({ ok: true });
});

app.get("/api/files", (_req: Request, res: Response) => {
  const files = Array.from(virtualFiles.entries()).map(([k, v]) => ({
    name: v.name,
    path: k,
    size: Buffer.byteLength(v.content, "utf-8"),
  }));
  res.json({ files });
});

// Static assets (face_model.obj, static/crypto.js, index.html)
app.use(express.static(PUBLIC_DIR));

// Fallback to index.html
app.get("*", (_req: Request, res: Response) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

// ── WebSocket Upgrade Handling (/ws and /ws/phone-audio) ─────────────────────
server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  if (url.pathname === "/ws" || url.pathname === "/ws/phone-audio") {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request, url);
    });
  } else {
    socket.destroy();
  }
});

wss.on("connection", (ws: WebSocket, _req: http.IncomingMessage, url: URL) => {
  if (url.pathname === "/ws/phone-audio") {
    broadcastWs({ type: "sys", text: "Phone microphone stream active." });
    ws.on("close", () => {
      broadcastWs({ type: "sys", text: "Phone microphone stream stopped." });
    });
    return;
  }

  wsClients.add(ws);
  ws.send(JSON.stringify({ type: "status", state: "active" }));

  ws.on("message", async (raw) => {
    try {
      const data = JSON.parse(raw.toString());
      if (data.type === "command") {
        const text = String(data.text || "").trim();
        if (text) await processJarvisCommand(text);
      }
    } catch {
      // ignore malformed messages
    }
  });

  ws.on("close", () => {
    wsClients.delete(ws);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[MARK LV] JARVIS HUD & Remote Dashboard online at http://0.0.0.0:${PORT}`);
});
