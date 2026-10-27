/** A Claude client that replays scripted messages, streaming each one's text first. */
export function fakeClient(script) {
  const requests = [];
  return {
    requests,
    beta: {
      messages: {
        stream(params) {
          requests.push(structuredClone(params));
          const message = script.shift();
          const listeners = {};
          return {
            on(event, listener) { listeners[event] = listener; return this; },
            async finalMessage() {
              if (message instanceof Error) throw message;
              for (const block of message.content) if (block.type === "text") listeners.text?.(block.text);
              return message;
            },
          };
        },
      },
    },
  };
}
