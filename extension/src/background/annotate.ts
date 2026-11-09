// `screenshot --annotate`: boxes for the refs of a fresh interactive snapshot, drawn into the
// captured image with an OffscreenCanvas. Nothing is injected into the page.

import * as cdp from './cdp';
import { snapshot } from './snapshot';
import { state } from './state';

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Annotation {
  ref: string;
  number: number;
  role: string;
  name: string;
  box: Box;
}

/** Annotations from a new snapshot (every element that has a ref); boxes in CSS px, relative to the viewport. */
export async function annotations(
  tabId: number,
  session: string,
  view: { width: number; height: number; offsetX: number; offsetY: number; full: boolean },
): Promise<Annotation[]> {
  const snap = await snapshot(tabId, {
    interactive: false,
    compact: false,
    urls: false,
    session,
  });
  const out: Annotation[] = [];
  const refs = Object.entries(snap.refs).sort(
    (a, b) => Number(a[0].slice(1)) - Number(b[0].slice(1)),
  );
  const table = state.refs[tabId] ?? {};
  for (const [ref, info] of refs) {
    const node = table[ref]?.backendNodeId;
    if (node === undefined) continue;
    let quads: number[][];
    try {
      ({ quads } = await cdp.send<{ quads: number[][] }>(tabId, 'DOM.getContentQuads', {
        backendNodeId: node,
      }));
    } catch {
      continue; // not rendered
    }
    const xs = quads.flatMap((q) => q.filter((_, i) => i % 2 === 0));
    const ys = quads.flatMap((q) => q.filter((_, i) => i % 2 === 1));
    if (xs.length === 0) continue;
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    const width = Math.max(...xs) - x;
    const height = Math.max(...ys) - y;
    if (width < 1 || height < 1) continue;
    // Only what the picture shows: the viewport, or the whole page for --full.
    const px = x + view.offsetX;
    const py = y + view.offsetY;
    if (!view.full && (x + width <= 0 || y + height <= 0 || x >= view.width || y >= view.height))
      continue;
    if (view.full && (px + width <= 0 || py + height <= 0)) continue;
    out.push({
      ref,
      number: Number(ref.slice(1)),
      role: info.role,
      name: info.name,
      box: {
        x: Math.round(view.full ? px : x),
        y: Math.round(view.full ? py : y),
        width: Math.round(width),
        height: Math.round(height),
      },
    });
  }
  return out;
}

/** `   [3] @e3 button "Increment"` per annotation, as agent-browser prints them. */
export function formatAnnotations(list: Annotation[]): string {
  return list
    .map(
      (a) =>
        `   [${String(a.number)}] @${a.ref} ${a.role}${a.name ? ` ${JSON.stringify(a.name)}` : ''}`,
    )
    .join('\n');
}

/**
 * Draw red outlines and number tags onto a PNG/JPEG. `cssWidth` is the CSS width the image shows.
 * Returns the encoded image.
 */
export async function drawAnnotations(
  image: Blob,
  list: Annotation[],
  cssWidth: number,
  format: 'png' | 'jpeg',
): Promise<Blob> {
  const bmp = await createImageBitmap(image);
  const scale = bmp.width / cssWidth;
  const canvas = new OffscreenCanvas(bmp.width, bmp.height);
  const g = canvas.getContext('2d');
  if (!g) throw new Error('Canvas unavailable');
  g.drawImage(bmp, 0, 0);
  const line = Math.max(2, Math.round(2 * scale));
  const fontPx = Math.round(12 * scale);
  g.font = `bold ${String(fontPx)}px sans-serif`;
  g.textBaseline = 'middle';
  for (const a of list) {
    const x = a.box.x * scale;
    const y = a.box.y * scale;
    g.strokeStyle = '#ff0000';
    g.lineWidth = line;
    g.strokeRect(x, y, a.box.width * scale, a.box.height * scale);
    const label = String(a.number);
    const w = Math.ceil(g.measureText(label).width + 6 * scale);
    const h = Math.ceil(fontPx + 4 * scale);
    const ty = y >= h ? y - h : y;
    g.fillStyle = '#ff0000';
    g.fillRect(x, ty, w, h);
    g.fillStyle = '#ffffff';
    g.fillText(label, x + 3 * scale, ty + h / 2);
  }
  return canvas.convertToBlob({ type: `image/${format}` });
}
