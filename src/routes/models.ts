import { FastifyInstance } from 'fastify';
import { getCachedModels, resolveModelName } from '../utils/models.js';

export async function modelsRoutes(fastify: FastifyInstance) {
  fastify.get('/v1/models', async (req, reply) => {
    const models = getCachedModels();
    return {
      object: 'list',
      data: models,
    };
  });

  fastify.get('/v1/models/:model', async (req: any, reply) => {
    const requestedModel = req.params?.model || '';
    const resolvedId = resolveModelName(requestedModel);
    const available = getCachedModels();
    const found = available.find(m => m.id === resolvedId) || available[0];

    return {
      id: found.id,
      object: 'model',
      created: found.created || Math.floor(Date.now() / 1000),
      owned_by: found.owned_by || 'command-code',
      permission: [],
      root: found.id,
      parent: null,
    };
  });
}
