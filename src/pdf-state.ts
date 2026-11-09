export interface Position {
  page: number;
  offset: number;
}

export interface Highlight {
  id: string;
  page: number;
  text: string;
  rects: [number, number, number, number][];
}

export interface Changes {
  position?: Position;
  adds: Highlight[];
  deletes: string[];
}

export interface ReaderState {
  position: Position | null;
  highlights: Highlight[];
}
