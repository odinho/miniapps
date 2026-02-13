import { createServer } from 'http';
import { handleRequest } from './api.js';

const PORT = parseInt(process.env.PORT || '3000');

const server = createServer(handleRequest);
server.listen(PORT, () => {
  console.log(`🍼 Babysovelogg server running on http://localhost:${PORT}`);
});
