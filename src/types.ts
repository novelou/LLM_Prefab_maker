export interface Settings {
  baseUrl: string;
  model: string;
  maxTokens: number;
  timeoutSeconds: number;
  temperature: number;
  runtimeSeconds: number;
  maxTriangles: number;
  maxMeshes: number;
  maxTextureSize: number;
  reasoningEffort: string;
}
export interface Stats {
  meshes: number;
  triangles: number;
  materials: number;
  textures: number;
  bytes: number;
  size: number[];
  min: number[];
  max: number[];
  warnings: string[];
}
export interface Version {
  id: string;
  source: string;
  prompt: string;
  seed: number;
  createdAt: string;
  model: string;
  stats: Stats;
  elapsedMs?: number;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  images?: string[];
  repaired?: boolean;
}
export interface Vision {
  accepted: boolean;
  answer: string;
  checkedAt: string;
  model: string;
}
