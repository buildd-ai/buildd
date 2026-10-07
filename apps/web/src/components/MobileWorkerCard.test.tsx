import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import MobileWorkerCard from './MobileWorkerCard';
test('legacy card names observed phase instead of inventing a percentage', () => {
  const html = renderToStaticMarkup(<MobileWorkerCard workerId="worker" name="Builder" status="running" taskTitle="Work" workspaceName={null} milestones={[{type:'checkpoint',event:'first_commit',label:'Commit',timestamp:10}]} turns={1} costUsd={null} startedAt={null} taskId="task" />);
  expect(html).toContain('Commit');
  expect(html).not.toContain('width:');
});
