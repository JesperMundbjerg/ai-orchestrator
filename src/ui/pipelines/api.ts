import type { PipelineLayoutInput, PipelineOverrideInput, PipelinePalette, PipelineTeamView } from "../../shared/pipeline.ts";

export class PipelineRequestError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "PUT",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => null) as T & { error?: string } | null;
  if (!response.ok || !data) throw new PipelineRequestError(response.status, data?.error ?? `The office did not answer (${response.status}).`);
  return data;
}
const base = (teamId: string) => `/api/world/teams/${encodeURIComponent(teamId)}/pipeline`;
export const pipelineApi = {
  team: (teamId: string) => request<PipelineTeamView>(base(teamId)),
  palette: (teamId: string) => request<PipelinePalette>(`${base(teamId)}/palette`),
  save: (teamId: string, input: PipelineOverrideInput) => request<PipelineTeamView>(base(teamId), input),
  layout: (teamId: string, input: PipelineLayoutInput) => request<PipelineTeamView>(`${base(teamId)}/layout`, input),
};
