/**
 * Predefined JSON Schema templates for structured artifact creation.
 *
 * Workers can call `list_artifact_templates` to discover available templates,
 * then use `create_artifact` with content following the corresponding schema.
 */

export const artifactTemplates: Record<string, { type: string; description: string; schema: object }> = {
  research_report: {
    type: 'report',
    description: 'Structured research report',
    schema: {
      type: 'object',
      properties: {
        findings: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              detail: { type: 'string' },
              confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
            },
            required: ['title', 'detail'],
          },
        },
        sources: { type: 'array', items: { type: 'string' } },
        summary: { type: 'string' },
      },
      required: ['findings', 'summary'],
    },
  },
  decision_recommendation: {
    type: 'recommendation',
    description: 'Decision recommendation with options analysis',
    schema: {
      type: 'object',
      properties: {
        options: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              pros: { type: 'array', items: { type: 'string' } },
              cons: { type: 'array', items: { type: 'string' } },
            },
            required: ['name'],
          },
        },
        recommendation: { type: 'string' },
        reasoning: { type: 'string' },
      },
      required: ['options', 'recommendation'],
    },
  },
  content_draft: {
    type: 'content',
    description: 'Content draft for publishing',
    schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        body: { type: 'string' },
        targetPlatform: { type: 'string' },
        metadata: { type: 'object' },
      },
      required: ['title', 'body'],
    },
  },
  monitoring_alert: {
    type: 'alert',
    description: 'Monitoring alert with severity and suggested action',
    schema: {
      type: 'object',
      properties: {
        severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'info'] },
        description: { type: 'string' },
        suggestedAction: { type: 'string' },
        source: { type: 'string' },
      },
      required: ['severity', 'description'],
    },
  },
};
