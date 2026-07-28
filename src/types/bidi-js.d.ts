// Minimal typings for `bidi-js`, which ships no declarations.
//
// Only the surface the Food List PDF renderer uses is declared: resolving
// Unicode Bidirectional Algorithm embedding levels so mixed Arabic/Latin lines
// (a Latin patient name in the Arabic form's Name field, the "2 coffees/day"
// style note) can be split into correctly ordered directional runs.
declare module "bidi-js" {
  export interface EmbeddingLevels {
    /** Resolved bidi level per character; odd = right-to-left. */
    levels: Uint8Array;
    paragraphs: { start: number; end: number; level: number }[];
  }

  export interface Bidi {
    getEmbeddingLevels(text: string, direction?: "ltr" | "rtl"): EmbeddingLevels;
    getReorderSegments(
      text: string,
      embeddingLevels: EmbeddingLevels,
      start?: number,
      end?: number,
    ): [number, number][];
  }

  export default function bidiFactory(): Bidi;
}
