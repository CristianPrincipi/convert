// linux-local: headless conversion engine for the right-click wheel. Runs in a hidden window of
// the desktop app (role "engine", see src/electron-preload.cjs) and answers the main process.
import { effect } from "@preact/signals";
import mime from "mime";

import { filePath } from "src/common/path";
import { detectFormatMatches } from "src/detectFormat";
import { ConvertPathNode, formatIdentifier, type FileData } from "src/FormatHandler";
import { ConversionOptions } from "src/main";
import type { CategoryType } from "src/Formats";
import { LoadingToolsText } from "./AppState";

export interface EngineFile {
  name: string;
  bytes: Uint8Array<ArrayBuffer>;
}

export type EngineRequest =
  | { id: number; op: "targets"; name: string }
  | { id: number; op: "convert"; files: EngineFile[]; target: string };

export interface DesktopEngine {
  ready: () => void;
  onRequest: (callback: (request: EngineRequest) => void) => void;
  respond: (id: number, result: unknown, error?: string) => void;
}

interface WheelItem {
  /** Convert's `format` key of the output, e.g. "jpeg" */
  id: string;
  label: string;
  ext: string;
  desc: string;
}

export interface WheelCategory {
  id: string;
  name: string;
  label: string[];
  items: WheelItem[];
}

/** The wheel's categories (FLIP's table, without 3D and vector): [format key, label, description] */
const CATEGORIES: { id: string; name: string; label: string[]; formats: string[][] }[] = [
  {
    id: "img",
    name: "Immagini",
    label: ["Immagini"],
    formats: [
      ["png", "PNG", "Immagine senza perdita"],
      ["jpeg", "JPEG", "Foto, compatibile ovunque"],
      ["webp", "WEBP", "Immagine leggera per il web"],
      ["bmp", "BMP", "Bitmap non compressa"],
      ["tiff", "TIFF", "Immagine per stampa e archivio"],
      ["gif", "GIF", "Immagine o animazione"],
      ["ico", "ICO", "Icona"],
    ],
  },
  {
    id: "doc",
    name: "PDF e documenti",
    label: ["PDF e", "documenti"],
    formats: [
      ["pdf", "PDF", "Documento PDF"],
      ["docx", "DOCX", "Documento Word"],
      ["odt", "ODT", "Documento LibreOffice"],
      ["markdown", "MD", "Markdown"],
      ["text", "TXT", "Solo il testo"],
      ["html", "HTML", "Pagina web"],
    ],
  },
  {
    id: "data",
    name: "Dati strutturati",
    label: ["Dati"],
    formats: [
      ["json", "JSON", "JSON"],
      ["jsonl", "JSONL", "Un record JSON per riga"],
      ["yaml", "YAML", "YAML"],
      ["toml", "TOML", "TOML"],
      ["xml", "XML", "XML"],
      ["csv", "CSV", "Tabella separata da virgole"],
      ["ini", "INI", "File di configurazione INI"],
    ],
  },
  {
    id: "arc",
    name: "Archivi",
    label: ["Archivi"],
    formats: [
      ["zip", "ZIP", "Archivio ZIP"],
      ["tar", "TAR", "Archivio TAR"],
      ["tar.gz", "TAR.GZ", "TAR compresso con gzip"],
      ["cbz", "CBZ", "Fumetto (immagini in ZIP)"],
      ["7z", "7Z", "Archivio 7-Zip"],
    ],
  },
  {
    id: "av",
    name: "Audio e video",
    label: ["Audio e", "video"],
    formats: [
      ["mp3", "MP3", "Audio compresso"],
      ["wav", "WAV", "Audio senza perdita"],
      ["flac", "FLAC", "Audio senza perdita, compresso"],
      ["mp4", "MP4", "Video"],
      ["matroska", "MKV", "Video Matroska"],
      ["webm", "WEBM", "Video per il web"],
    ],
  },
];

/**
 * Which of the wheel's formats make sense for each kind of source file ("*" = all of the category).
 * Convert can reach almost anything (an MP3 as a web page, a DOCX as a video), so the wheel only
 * offers these; the full app still has every route. Kinds missing here (fonts, 3D…) get no filter.
 */
const SENSIBLE: Partial<Record<CategoryType, Record<string, "*" | string[]>>> = {
  image: { img: "*", doc: ["pdf"], arc: "*", av: ["mp4", "webm"] },
  vector: { img: "*", doc: ["pdf"], arc: "*" },
  video: { av: "*", img: ["png", "jpeg", "webp", "gif"], arc: "*" },
  audio: { av: "*", arc: "*" },
  document: { doc: "*", img: ["png", "jpeg"], arc: "*" },
  presentation: { doc: ["pdf", "html"], img: ["png", "jpeg"], arc: "*" },
  text: { doc: "*", arc: "*" },
  code: { doc: ["text", "html", "pdf"], arc: "*" },
  data: { data: "*", doc: ["pdf", "html", "markdown", "text"], arc: "*" },
  spreadsheet: { data: ["csv", "json"], doc: ["pdf", "html"], arc: "*" },
  database: { data: "*", arc: "*" },
  archive: { arc: "*" },
};

/** Whether the wheel offers `key` of `category` for a source of these kinds */
function sensible(kinds: CategoryType[], category: string, key: string) {
  const rules = kinds.map((kind) => SENSIBLE[kind]).filter((rule) => rule !== undefined);
  if (!rules.length) return true;
  return rules.some((rule) => rule[category] === "*" || rule[category]?.includes(key));
}

function sourceNode(name: string): ConvertPathNode | null {
  const fromFormats = [...ConversionOptions.keys()].filter((format) => format.from);
  const file = { name, type: mime.getType(name) ?? "" };
  const match = detectFormatMatches(file, fromFormats, { loose: true })[0];
  if (!match) return null;
  return new ConvertPathNode(ConversionOptions.get(match.format)!, match.format);
}

function targetNode(key: string): ConvertPathNode | null {
  for (const [format, handler] of ConversionOptions) {
    if (format.to && format.format === key) return new ConvertPathNode(handler, format);
  }
  return null;
}

async function targets(name: string) {
  const from = sourceNode(name);
  const costs = from
    ? await window.traversionGraph.getFormatCosts(from.format, "to", false)
    : new Map<string, number>();
  const fromId = from ? formatIdentifier(from.format) : null;
  // The same format can be declared by several tools with different categories (CSV is "data" for
  // one and "document" for another): all of them count.
  const kinds = [...ConversionOptions.keys()]
    .filter((format) => formatIdentifier(format) === fromId)
    .flatMap((format) => [format.category].flat());
  const categories: WheelCategory[] = CATEGORIES.map((category) => ({
    id: category.id,
    name: category.name,
    label: category.label,
    items: category.formats.flatMap(([key, label, desc]) => {
      const to = targetNode(key);
      if (!to) return [];
      const id = formatIdentifier(to.format);
      if (id === fromId || !Number.isFinite(costs.get(id))) return [];
      if (!sensible(kinds, category.id, key)) return [];
      return [{ id: key, label, ext: to.format.extension, desc }];
    }),
  }));
  return { source: from?.format.name ?? null, categories };
}

async function convert(files: EngineFile[], target: string) {
  const to = targetNode(target);
  if (!to) throw new Error(`Unknown output format "${target}"`);

  // Files of the same type are converted together, as the app does with a multi-file selection
  const groups = new Map<string, { from: ConvertPathNode; files: FileData[] }>();
  const failed: string[] = [];
  for (const file of files) {
    const from = sourceNode(file.name);
    if (!from) {
      failed.push(file.name);
      continue;
    }
    const key = formatIdentifier(from.format);
    if (!groups.has(key)) groups.set(key, { from, files: [] });
    groups.get(key)!.files.push({ name: file.name, bytes: file.bytes });
  }

  const outputs: EngineFile[] = [];
  for (const group of groups.values()) {
    const names = group.files.map((file) => file.name);
    try {
      const result = await window.tryConvertByTraversing(group.files, group.from, to);
      if (!result) {
        failed.push(...names);
        continue;
      }
      for (const file of result.files) {
        outputs.push({ name: filePath(file).replaceAll("/", "_"), bytes: file.bytes });
      }
    } catch (error) {
      console.error(error);
      failed.push(...names);
    }
  }
  return { outputs, failed };
}

const engine = window.desktopEngine;

if (engine) {
  // One conversion at a time: handlers and their workers are shared. Looking up the formats for
  // the wheel only reads the graph, so it never waits behind a running conversion.
  let conversions: Promise<unknown> = Promise.resolve();

  const answer = (id: number, work: Promise<unknown>) =>
    work
      .then((result) => engine.respond(id, result))
      .catch((error: unknown) => engine.respond(id, null, String(error)));

  engine.onRequest((request) => {
    if (request.op === "targets") {
      void answer(request.id, targets(request.name));
      return;
    }
    conversions = conversions.then(() =>
      answer(request.id, convert(request.files, request.target)),
    );
  });

  let announced = false;
  effect(() => {
    if (LoadingToolsText.value === undefined && !announced) {
      announced = true;
      engine.ready();
    }
  });
}
