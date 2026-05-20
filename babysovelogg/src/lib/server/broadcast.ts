// SSE broadcast to connected clients
const sseClients = new Set<ReadableStreamDefaultController>();
const encoder = new TextEncoder();

export function addClient(controller: ReadableStreamDefaultController) {
  sseClients.add(controller);
}

export function removeClient(controller: ReadableStreamDefaultController) {
  sseClients.delete(controller);
}

export function broadcast(eventType: string, data: Record<string, unknown>) {
  const msg = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
  const encoded = encoder.encode(msg);
  for (const client of sseClients) {
    try {
      client.enqueue(encoded);
    } catch {
      sseClients.delete(client);
    }
  }
}
