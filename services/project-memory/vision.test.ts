import { describe, expect, it } from 'vitest'
import { fallbackImageDescription, parseImageDescription } from './vision'

describe('parseImageDescription', () => {
  it('parses a clean JSON object', () => {
    const r = parseImageDescription(
      '{"title":"Login Mockup","description":"UI mockup of the sign-in screen.","ocrText":"Sign in\\nEmail"}'
    )
    expect(r).toEqual({
      title: 'Login Mockup',
      description: 'UI mockup of the sign-in screen.',
      ocrText: 'Sign in\nEmail'
    })
  })

  it('strips code fences and surrounding prose', () => {
    const raw = 'Here you go:\n```json\n{"title":"T","description":"D","ocrText":""}\n```'
    expect(parseImageDescription(raw)).toEqual({ title: 'T', description: 'D', ocrText: '' })
  })

  it('tolerates a missing ocrText field (empty string)', () => {
    expect(parseImageDescription('{"title":"T","description":"D"}')).toEqual({
      title: 'T',
      description: 'D',
      ocrText: ''
    })
  })

  it('returns null on garbage or missing required fields', () => {
    expect(parseImageDescription('not json at all')).toBeNull()
    expect(parseImageDescription('{"title":"","description":"D"}')).toBeNull()
    expect(parseImageDescription('{"description":"D"}')).toBeNull()
  })
})

describe('fallbackImageDescription', () => {
  it('uses the filename and carries no OCR text', () => {
    expect(fallbackImageDescription('shot.png')).toEqual({
      title: 'shot.png',
      description: 'Image file (no AI description available)',
      ocrText: ''
    })
  })
})
