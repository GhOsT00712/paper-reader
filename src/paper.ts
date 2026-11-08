export interface Paper extends PaperDetails {
  id: number;
  url: string;
  created_at: string;
  read_at: string | null;
  pinned?: number;
}

export interface PaperDetails {
  title: string;
  authors?: string;
  tags?: string;
  note?: string;
}
