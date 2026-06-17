import test from 'node:test'
import assert from 'node:assert/strict'

import {
  isEditableKeyboardTarget,
  shouldSuppressGlobalShortcut,
} from '../src/keyboardShortcuts.ts'

test('editable form targets suppress global playback shortcuts', () => {
  const inputTarget = { tagName: 'input' }
  const textareaTarget = { tagName: 'TEXTAREA' }

  assert.equal(isEditableKeyboardTarget(inputTarget), true)
  assert.equal(isEditableKeyboardTarget(textareaTarget), true)
  assert.equal(shouldSuppressGlobalShortcut({ target: inputTarget }), true)
})

test('Chinese IME composition suppresses global playback shortcuts', () => {
  assert.equal(shouldSuppressGlobalShortcut({ isComposing: true, target: null }), true)
})

test('non-editable targets keep global playback shortcuts enabled', () => {
  const buttonTarget = { tagName: 'BUTTON' }

  assert.equal(isEditableKeyboardTarget(buttonTarget), false)
  assert.equal(shouldSuppressGlobalShortcut({ target: buttonTarget }), false)
})

test('nested editable controls suppress global playback shortcuts', () => {
  const nestedTarget = {
    tagName: 'SPAN',
    closest: (selector: string) => selector.includes('textarea') ? {} : null,
  }

  assert.equal(isEditableKeyboardTarget(nestedTarget), true)
})
