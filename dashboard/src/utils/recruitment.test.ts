import assert from 'node:assert/strict';
import test from 'node:test';
import {
  recruitmentCurrentInterviewPhase,
  recruitmentRequiredInterviewPhase,
  recruitmentTransitionGroup,
  recruitmentTransitionLabel,
} from './recruitment.ts';

test('derives only the current interview phase from the recruitment status', () => {
  assert.equal(recruitmentCurrentInterviewPhase('APROVADO'), 'FASE_2_ENTREVISTA_FOCADA');
  assert.equal(recruitmentCurrentInterviewPhase('DOCUMENTACAO'), 'FASE_3_CONTRATACAO');
  assert.notEqual(recruitmentCurrentInterviewPhase('DOCUMENTACAO'), 'FASE_2_ENTREVISTA_FOCADA');
  assert.equal(recruitmentCurrentInterviewPhase('CONTRATADO'), null);
});

test('requires a new focused interview when returning from second evaluation to interview/test', () => {
  assert.equal(recruitmentRequiredInterviewPhase('EM_AVALIACAO_FASE_2', 'APROVADO'), 'FASE_2_ENTREVISTA_FOCADA');
  assert.equal(recruitmentTransitionLabel('EM_AVALIACAO_FASE_2', 'APROVADO'), 'Marcar nova entrevista/teste');
});

test('keeps the existing phase requirements for first advancement and DP interview', () => {
  assert.equal(recruitmentRequiredInterviewPhase('EM_AVALIACAO', 'APROVADO'), 'FASE_2_ENTREVISTA_FOCADA');
  assert.equal(recruitmentRequiredInterviewPhase('EM_AVALIACAO_FASE_2', 'DOCUMENTACAO'), 'FASE_3_CONTRATACAO');
  assert.equal(recruitmentRequiredInterviewPhase('APROVADO', 'EM_AVALIACAO_FASE_2'), null);
});

test('groups stage actions into advance, hold and close rows', () => {
  assert.equal(recruitmentTransitionGroup('EM_AVALIACAO', 'APROVADO'), 'advance');
  assert.equal(recruitmentTransitionGroup('EM_AVALIACAO_FASE_2', 'APROVADO'), 'hold');
  assert.equal(recruitmentTransitionGroup('APROVADO', 'EM_AVALIACAO_FASE_2'), 'hold');
  assert.equal(recruitmentTransitionGroup('DOCUMENTACAO', 'CONTRATADO'), 'advance');
  assert.equal(recruitmentTransitionGroup('EM_AVALIACAO_FASE_2', 'REPROVADO'), 'close');
  assert.equal(recruitmentTransitionGroup('APROVADO', 'DESISTIU'), 'close');
  assert.equal(recruitmentTransitionGroup('CONTRATADO', 'DESISTIU'), 'close');
  assert.equal(recruitmentTransitionLabel('CONTRATADO', 'DESISTIU'), 'Desistir da vaga');
});
