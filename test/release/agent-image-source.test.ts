import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error Image workflow verification uses dependency-free JavaScript.
import { resolveAgentImageSource } from '../../scripts/kubernetes/agent-image-source.mjs';

const repository = 'kyriswu/huahuo-agent';
const main = 'a'.repeat(40);
const source = 'b'.repeat(40);
const env = {
  GITHUB_REPOSITORY: repository,
  GITHUB_REF: 'refs/heads/main',
  GITHUB_REF_PROTECTED: 'true',
  GITHUB_SHA: main,
  GITHUB_EVENT_NAME: 'workflow_dispatch',
  AGENT_IMAGE_SOURCE_SHA: source,
  AGENT_IMAGE_REPOSITORY: 'registry.example.com:5443/huahuo/agent',
  GH_TOKEN: 'fixture',
};

function github({ head = source, protectedBranch = true, event = 'push', conclusion = 'success' } = {}) {
  return vi.fn(async (url: string | URL | Request) => {
    const { pathname, searchParams } = new URL(String(url));
    if (pathname.endsWith('/branches/test')) {
      return Response.json({ name: 'test', protected: protectedBranch, commit: { sha: head } });
    }
    if (pathname.endsWith('/actions/workflows/agent-ci.yml/runs')) {
      expect(searchParams.get('head_sha')).toBe(source);
      return Response.json({ workflow_runs: [{
        head_sha: source, head_branch: 'test', event, status: 'completed', conclusion,
        path: '.github/workflows/agent-ci.yml', head_repository: { full_name: repository },
      }] });
    }
    throw Error('unexpected request');
  });
}

describe('Agent image source verification', () => {
  it('selects the checked protected test SHA and configured ACR repository', async () => {
    const verified = await resolveAgentImageSource(env, github());
    expect(verified).toEqual({
      source_sha: source,
      image_repository: env.AGENT_IMAGE_REPOSITORY,
    });
  });

  it.each([
    { head: 'c'.repeat(40) },
    { protectedBranch: false },
    { event: 'pull_request' },
    { conclusion: 'failure' },
  ])('rejects a stale or ineligible source (%j)', async (fixture) => {
    await expect(resolveAgentImageSource(env, github(fixture))).rejects.toThrow(/NOT_VERIFIED/u);
  });

  it.each([
    { GITHUB_REF_PROTECTED: 'false' },
    { GITHUB_EVENT_NAME: 'push' },
    { AGENT_IMAGE_SOURCE_SHA: 'test' },
    { AGENT_IMAGE_REPOSITORY: 'https://registry.example.com/agent' },
    { AGENT_IMAGE_REPOSITORY: 'registry.example.com/agent:latest' },
    { AGENT_IMAGE_REPOSITORY: 'huahuo/agent' },
  ])('rejects invalid dispatch configuration before requesting source (%j)', async (invalid) => {
    const request = github();
    await expect(resolveAgentImageSource({ ...env, ...invalid }, request)).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
});
