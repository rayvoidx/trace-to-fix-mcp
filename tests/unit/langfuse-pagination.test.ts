/**
 * Langfuse adapter 페이지네이션 검증
 *
 * observation/score 100건 초과 시 전 페이지를 수집하는지 확인.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { lfGetMock } = vi.hoisted(() => ({ lfGetMock: vi.fn() }));
vi.mock("../../src/adapters/langfuse/client.js", () => ({ lfGet: lfGetMock }));

import { fetchObservations } from "../../src/adapters/langfuse/observations.js";
import { fetchScores } from "../../src/adapters/langfuse/scores.js";

function makeObservation(id: string) {
  return {
    id,
    traceId: "trace-1",
    type: "SPAN",
    name: null,
    startTime: "2026-08-30T00:00:00Z",
    endTime: null,
    input: null,
    output: null,
    metadata: null,
    level: "DEFAULT",
    statusMessage: null,
    model: null,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    calculatedTotalCost: null,
  };
}

function page(data: unknown[], pageNum: number, totalPages: number) {
  return { data, meta: { totalItems: 150, page: pageNum, totalPages } };
}

beforeEach(() => {
  lfGetMock.mockReset();
});

describe("fetchObservations pagination", () => {
  it("collects all pages when observations exceed 100", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => makeObservation(`obs-${i}`));
    const page2 = Array.from({ length: 50 }, (_, i) => makeObservation(`obs-${100 + i}`));
    lfGetMock
      .mockResolvedValueOnce(page(page1, 1, 2))
      .mockResolvedValueOnce(page(page2, 2, 2));

    const result = await fetchObservations("trace-1");

    expect(result).toHaveLength(150);
    expect(lfGetMock).toHaveBeenCalledTimes(2);
    expect(lfGetMock).toHaveBeenLastCalledWith("/observations", {
      traceId: "trace-1",
      limit: "100",
      page: "2",
    });
  });

  it("stops after one page when results fit", async () => {
    lfGetMock.mockResolvedValueOnce(page([makeObservation("obs-0")], 1, 1));

    const result = await fetchObservations("trace-1");

    expect(result).toHaveLength(1);
    expect(lfGetMock).toHaveBeenCalledTimes(1);
  });
});

describe("fetchScores pagination", () => {
  it("collects all pages when scores exceed 100", async () => {
    const score = (id: string) => ({
      id,
      traceId: "trace-1",
      observationId: null,
      name: "correctness",
      value: 0.5,
      dataType: "NUMERIC",
      comment: null,
      source: "API",
    });
    const page1 = Array.from({ length: 100 }, (_, i) => score(`s-${i}`));
    const page2 = Array.from({ length: 20 }, (_, i) => score(`s-${100 + i}`));
    lfGetMock
      .mockResolvedValueOnce(page(page1, 1, 2))
      .mockResolvedValueOnce(page(page2, 2, 2));

    const result = await fetchScores("trace-1");

    expect(result).toHaveLength(120);
    expect(lfGetMock).toHaveBeenCalledTimes(2);
  });
});
