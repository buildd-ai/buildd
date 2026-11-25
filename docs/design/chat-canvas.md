---
general_rules: "[Voice and hard objects](design-system.md#11-voice-and-hard-objects)"
assertions:
  - id: "chat-canvas-route"
    type: "route"
    method: "GET"
    path: "/api/chat/canvas"
    file: "apps/web/src/app/api/chat/canvas/route.ts"
  - id: "chat-canvas-component-tests"
    type: "test_file"
    path: "apps/web/src/components/chat/ChatCanvas.dom.test.tsx"
---

# chat-canvas

This design doc's body lives in the private knowledge base at `knowledge-base: buildd/design/chat-canvas.md`; workers read it with `recall scope=docs`. Only the frontmatter stays here, because its assertions are checked against the code on every push (see `scripts/check-spec-conformance.ts`).
