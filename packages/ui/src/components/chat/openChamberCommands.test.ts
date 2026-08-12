import { describe, expect, test } from 'bun:test';

import {
  getOpenChamberCommands,
  mergeOpenChamberCommands,
  parseSideChatCommand,
} from './openChamberCommands';

describe('OpenChamber side commands', () => {
  test('discovers commands only on web or desktop main chat', () => {
    expect(getOpenChamberCommands({ surface: 'main', isMobile: false, isVSCode: false }).map((item) => item.name)).toEqual(['side', 'btw']);
    expect(getOpenChamberCommands({ surface: 'embedded', isMobile: false, isVSCode: false })).toEqual([]);
    expect(getOpenChamberCommands({ surface: 'main', isMobile: true, isVSCode: false })).toEqual([]);
    expect(getOpenChamberCommands({ surface: 'main', isMobile: false, isVSCode: true })).toEqual([]);
  });

  test('adds localized descriptions to both aliases', () => {
    expect(getOpenChamberCommands({
      surface: 'main',
      isMobile: false,
      isVSCode: false,
      sideChatDescription: 'Localized side description',
      btwDescription: 'Localized alias description',
    }).map((item) => item.description)).toEqual([
      'Localized side description',
      'Localized alias description',
    ]);
  });

  test('parses exact case-insensitive aliases and preserves multiline trailing text', () => {
    expect(parseSideChatCommand('/SIDE explain this\nwith details')).toEqual({ name: 'side', prompt: 'explain this\nwith details' });
    expect(parseSideChatCommand('/btw')).toEqual({ name: 'btw', prompt: '' });
    expect(parseSideChatCommand('/sidebar explain this')).toBeNull();
    expect(parseSideChatCommand(' /side explain this')).toBeNull();
  });

  test('keeps OpenChamber commands ahead of colliding project commands without duplicates', () => {
    const merged = mergeOpenChamberCommands(
      getOpenChamberCommands({ surface: 'main', isMobile: false, isVSCode: false }),
      [{ id: 'project:side', name: 'side' }, { id: 'project:test', name: 'test' }],
    );
    expect(merged.map((item) => item.id)).toEqual(['openchamber:side', 'openchamber:btw', 'project:test']);
  });
});
