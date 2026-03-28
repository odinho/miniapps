// SSE broadcast to connected clients
const sseClients = new Set<ReadableStreamDefaultController>();

export function addClient(controller: ReadableStreamDefaultController) {
  sseClients.add(controller);
}

export function removeClient(controller: ReadableStreamDefaultController) {
  sseClients.delete(controller);
}

export function broadcast(eventType: string, data: Record<string, unknown>) {
  const msg = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
  const encoder = new TextEncoder();
  for (const client of sseClients) {
    try {
      client.enqueue(encoder.encode(msg));
    } catch {
      sseClients.delete(client);
    }
  }
}
