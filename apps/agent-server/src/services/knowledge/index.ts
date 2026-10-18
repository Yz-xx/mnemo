export type { RetrievalGovernance } from './retrieval.js';
export type { DocumentInput } from './service.js';
export { KnowledgeStore } from './store.js';
export { callEmbedding, retrieveChunks, runRetrieval } from './retrieval.js';
export {
  addDocument,
  describeAddFailure,
  describeUpdateFailure,
  parseDocumentInput,
  updateDocument,
} from './service.js';
