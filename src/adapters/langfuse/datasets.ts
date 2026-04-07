/**
 * Langfuse Datasets Write Adapter
 *
 * 데이터셋 생성, 항목 추가.
 * Langfuse API v2: POST /api/public/v2/datasets, /v2/dataset-items
 */
import { lfGet, lfPost } from "./client.js";
import { logger } from "../../utils/logger.js";

export interface LfDataset {
  id: string;
  name: string;
  description: string | null;
  metadata: Record<string, unknown>;
}

export interface LfDatasetItem {
  id: string;
  datasetName: string;
  input: unknown;
  expectedOutput: unknown;
  metadata: Record<string, unknown>;
  sourceTraceId: string | null;
  sourceObservationId: string | null;
}

export interface CreateDatasetInput {
  name: string;
  description?: string;
  metadata?: Record<string, unknown>;
}

export interface CreateDatasetItemInput {
  datasetName: string;
  input: unknown;
  expectedOutput?: unknown;
  metadata?: Record<string, unknown>;
  sourceTraceId?: string;
  sourceObservationId?: string;
}

/** Create a new dataset */
export async function createDataset(
  input: CreateDatasetInput,
): Promise<LfDataset> {
  logger.info({ name: input.name }, "Creating dataset");
  return lfPost<LfDataset>("/v2/datasets", input);
}

/** Add an item to a dataset */
export async function createDatasetItem(
  input: CreateDatasetItemInput,
): Promise<LfDatasetItem> {
  return lfPost<LfDatasetItem>("/v2/dataset-items", input);
}

/** Add multiple items to a dataset (batch) */
export async function addDatasetItems(
  datasetName: string,
  items: Array<{
    input: unknown;
    expectedOutput?: unknown;
    metadata?: Record<string, unknown>;
    sourceTraceId?: string;
  }>,
): Promise<LfDatasetItem[]> {
  logger.info({ datasetName, count: items.length }, "Adding dataset items");

  const results: LfDatasetItem[] = [];
  for (const item of items) {
    const created = await createDatasetItem({
      datasetName,
      ...item,
    });
    results.push(created);
  }
  return results;
}

/** List datasets */
export async function listDatasets(
  page = 1,
  limit = 50,
): Promise<{ data: LfDataset[]; meta: { totalItems: number } }> {
  return lfGet("/v2/datasets", { page: String(page), limit: String(limit) });
}
