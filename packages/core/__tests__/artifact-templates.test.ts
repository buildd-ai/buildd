/**
 * Unit test: Artifact templates
 *
 * Tests:
 *   1. All templates have required fields
 *   2. Schemas are valid JSON Schema objects
 *   3. Template types match known artifact types
 *   4. Each template has required properties defined
 */

import { describe, test, expect } from 'bun:test';
import { artifactTemplates } from '../artifact-templates';

const KNOWN_ARTIFACT_TYPES = [
  'content', 'report', 'data', 'link', 'summary',
  'email_draft', 'social_post', 'analysis', 'recommendation', 'alert', 'calendar_event',
];

describe('Artifact Templates', () => {
  test('templates object is not empty', () => {
    expect(Object.keys(artifactTemplates).length).toBeGreaterThan(0);
  });

  test('each template has type, description, and schema', () => {
    for (const [name, tmpl] of Object.entries(artifactTemplates)) {
      expect(tmpl.type).toBeTruthy();
      expect(typeof tmpl.type).toBe('string');
      expect(tmpl.description).toBeTruthy();
      expect(typeof tmpl.description).toBe('string');
      expect(tmpl.schema).toBeTruthy();
      expect(typeof tmpl.schema).toBe('object');
    }
  });

  test('template types are valid artifact types', () => {
    for (const [name, tmpl] of Object.entries(artifactTemplates)) {
      expect(KNOWN_ARTIFACT_TYPES).toContain(tmpl.type);
    }
  });

  test('schemas have type: object at root', () => {
    for (const [name, tmpl] of Object.entries(artifactTemplates)) {
      const schema = tmpl.schema as any;
      expect(schema.type).toBe('object');
    }
  });

  test('schemas have properties defined', () => {
    for (const [name, tmpl] of Object.entries(artifactTemplates)) {
      const schema = tmpl.schema as any;
      expect(schema.properties).toBeTruthy();
      expect(Object.keys(schema.properties).length).toBeGreaterThan(0);
    }
  });

  test('schemas have required fields listed', () => {
    for (const [name, tmpl] of Object.entries(artifactTemplates)) {
      const schema = tmpl.schema as any;
      expect(Array.isArray(schema.required)).toBe(true);
      expect(schema.required.length).toBeGreaterThan(0);
      // All required fields should exist in properties
      for (const field of schema.required) {
        expect(schema.properties[field]).toBeTruthy();
      }
    }
  });

  test('research_report template has findings and summary', () => {
    const tmpl = artifactTemplates.research_report;
    expect(tmpl).toBeTruthy();
    expect(tmpl.type).toBe('report');
    const schema = tmpl.schema as any;
    expect(schema.properties.findings).toBeTruthy();
    expect(schema.properties.summary).toBeTruthy();
    expect(schema.required).toContain('findings');
    expect(schema.required).toContain('summary');
  });

  test('decision_recommendation template has options and recommendation', () => {
    const tmpl = artifactTemplates.decision_recommendation;
    expect(tmpl).toBeTruthy();
    expect(tmpl.type).toBe('recommendation');
    const schema = tmpl.schema as any;
    expect(schema.properties.options).toBeTruthy();
    expect(schema.properties.recommendation).toBeTruthy();
  });

  test('monitoring_alert template has severity enum', () => {
    const tmpl = artifactTemplates.monitoring_alert;
    expect(tmpl).toBeTruthy();
    expect(tmpl.type).toBe('alert');
    const schema = tmpl.schema as any;
    expect(schema.properties.severity.enum).toContain('critical');
    expect(schema.properties.severity.enum).toContain('low');
  });
});
