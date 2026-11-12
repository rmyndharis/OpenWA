import '../../test-helpers/register-hooks.ts';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { pauseOtherMedia } from './mediaPlayback.ts';

before(async () => {
  const { installJsdomGlobals } = await import('../../test-helpers/jsdom.ts');
  await installJsdomGlobals();
});

test('pauseOtherMedia pauses other playing audio and video elements', () => {
  const audio1 = document.createElement('audio');
  const audio2 = document.createElement('audio');
  const video1 = document.createElement('video');

  let audio1Paused = false;
  let video1Paused = false;

  Object.defineProperty(audio1, 'paused', { get: () => audio1Paused, configurable: true });
  Object.defineProperty(audio2, 'paused', { get: () => false, configurable: true });
  Object.defineProperty(video1, 'paused', { get: () => video1Paused, configurable: true });

  audio1.pause = () => {
    audio1Paused = true;
  };
  video1.pause = () => {
    video1Paused = true;
  };

  document.body.appendChild(audio1);
  document.body.appendChild(audio2);
  document.body.appendChild(video1);

  // When audio2 starts playing, it pauses audio1 and video1
  pauseOtherMedia(audio2);

  assert.equal(audio1Paused, true, 'audio1 should have been paused');
  assert.equal(video1Paused, true, 'video1 should have been paused');

  audio1.remove();
  audio2.remove();
  video1.remove();
});
