/**
 * This module calculates the layout of a text string. Currently the only
 * supported inline node is text. All other nodes are using block layout.
 */
import type { LayoutContext } from './layout'

import getYoga from './yoga'
import { v } from './utils'
import text from './builder/text'
import shadow from './builder/shadow'

export default function* buildTextNodes(
  content: string,
  context: LayoutContext
) {
  const Yoga = getYoga()

  // @TODO: Support "lang" attribute to modify the locale
  const locale = 'en'

  // @ts-ignore
  const wordSegmenter = new Intl.Segmenter(locale, { granularity: 'word' })
  // @ts-ignore
  const graphemeSegmenter = new Intl.Segmenter(locale, {
    granularity: 'grapheme',
  })

  const {
    parentStyle,
    parent,
    font,
    id,
    isInheritingTransform,
    debug,
    embedFont,
    graphemeImages,
  } = context

  if (parentStyle.textTransform === 'uppercase') {
    content = content.toLocaleUpperCase(locale)
  } else if (parentStyle.textTransform === 'lowercase') {
    content = content.toLocaleLowerCase(locale)
  } else if (parentStyle.textTransform === 'capitalize') {
    content = [...wordSegmenter.segment(content)]
      // For each word...
      .map((seg) => {
        // ...split into graphemes...
        return [...graphemeSegmenter.segment(seg.segment)]
          .map((grapheme, index) => {
            // ...and make the first grapheme uppercase
            return index === 0
              ? grapheme.segment.toLocaleUpperCase(locale)
              : grapheme.segment
          })
          .join('')
      })
      .join('')
  }

  const segmenter = v(
    parentStyle.wordBreak,
    {
      normal: wordSegmenter,
      'break-all': graphemeSegmenter,
      'break-word': graphemeSegmenter,
      'keep-all': wordSegmenter,
    },
    wordSegmenter
  )

  const words = [...segmenter.segment(content)].map((seg) => seg.segment)

  // Create a container node for this text fragment.
  const textContainer = Yoga.Node.create()
  textContainer.setAlignItems(Yoga.ALIGN_BASELINE)
  if (parentStyle.textAlign === 'left') {
    textContainer.setJustifyContent(Yoga.JUSTIFY_FLEX_START)
  } else if (parentStyle.textAlign === 'center') {
    textContainer.setJustifyContent(Yoga.JUSTIFY_CENTER)
  } else if (parentStyle.textAlign === 'right') {
    textContainer.setJustifyContent(Yoga.JUSTIFY_FLEX_END)
  } else if (parentStyle.textAlign === 'justify') {
    textContainer.setJustifyContent(Yoga.JUSTIFY_SPACE_BETWEEN)
  }
  parent.insertChild(textContainer, parent.getChildCount())

  // Get the correct font according to the container style.
  // @TODO: Support font family fallback based on the glyphs of the font.
  const resolvedFont = font.getFont(parentStyle as any)
  const ascent =
    (resolvedFont.ascender / resolvedFont.unitsPerEm) *
    (parentStyle.fontSize as number)
  const descent =
    -(resolvedFont.descender / resolvedFont.unitsPerEm) *
    (parentStyle.fontSize as number)
  const glyphHeight = ascent + descent
  const lineHeight = glyphHeight * 1.2

  const { textAlign } = parentStyle

  // Compute the layout.
  let lineWidth = []
  let lineSegmentNumber = []
  let wordsInLayout: (null | {
    x: number
    y: number
    width: number
    line: number
    lineIndex: number
  })[] = []

  textContainer.setMeasureFunc((width, _widthMode, _height, _heightMode) => {
    let lines = []
    let remainingSpace = ''
    let remainingSpaceWidth = 0
    let currentLine = ''
    let currentWidth = 0
    let maxWidth = 0
    let lineIndex = -1

    lineWidth = []
    lineSegmentNumber = [0]

    // We naively implement the width calculation without proper kerning.
    // @TODO: Support cases like `white-space: pre` and `pre-wrap`.
    // @TODO: Support different writing modes.
    // @TODO: Support RTL languages.
    for (let i = 0; i < words.length; i++) {
      const word = words[i]
      if ([' ', '\n', '\t', '　'].includes(word)) {
        remainingSpace += word
        remainingSpaceWidth = font.measure(
          resolvedFont,
          remainingSpace,
          parentStyle as any
        )

        wordsInLayout[i] = null
      } else {
        const w =
          graphemeImages && graphemeImages[word]
            ? (parentStyle.fontSize as number)
            : font.measure(resolvedFont, word, parentStyle as any)

        // This is the start of the line, we can ignore all spaces here.
        if (!currentWidth) {
          remainingSpace = ''
          remainingSpaceWidth = 0
        }

        if (currentWidth + remainingSpaceWidth + w > width) {
          // Start a new line, spaces can be ignored.
          lineWidth.push(currentWidth)
          lines.push(currentLine)
          currentLine = word
          currentWidth = w
          lineSegmentNumber.push(1)
          lineIndex = -1
        } else {
          // It fits into the current line.
          currentLine += remainingSpace + word
          currentWidth += remainingSpaceWidth + w
          lineSegmentNumber[lineSegmentNumber.length - 1]++
        }

        remainingSpace = ''
        remainingSpaceWidth = 0
        lineIndex++

        maxWidth = Math.max(maxWidth, currentWidth)
        wordsInLayout[i] = {
          y: lines.length * lineHeight,
          x: currentWidth - w,
          width: w,
          line: lines.length,
          lineIndex,
        }
      }

      // node.setHeight(measured.ascent * 1.2)
      // node.setMargin(Yoga.EDGE_BOTTOM, measured.descent * 1.2)
    }
    if (currentWidth) {
      lines.push(currentLine)
      lineWidth.push(currentWidth)
    }

    // If there are multiple lines, we need to stretch it to fit the container.
    if (lines.length > 1) {
      maxWidth = width
    }

    // @TODO: Support `line-height`.
    return { width: maxWidth, height: lines.length * lineHeight }
  })

  const [x, y] = yield

  let result = ''

  if (parentStyle.position === 'absolute') {
    textContainer.calculateLayout()
  }
  const {
    left: containerLeft,
    top: containerTop,
    width: containerWidth,
  } = textContainer.getComputedLayout()

  // Attach offset to the current node.
  const left = x + containerLeft
  const top = y + containerTop

  for (let i = 0; i < words.length; i++) {
    // Skip whitespace.
    if (!wordsInLayout[i]) continue

    const word = words[i]

    let path: string | null = null
    let image: string | null = null

    let topOffset = wordsInLayout[i].y
    let leftOffset = wordsInLayout[i].x
    const width = wordsInLayout[i].width
    const height = lineHeight

    // Calculate alignment.
    const remainingWidth = containerWidth - lineWidth[wordsInLayout[i].line]
    if (textAlign === 'right' || textAlign === 'end') {
      leftOffset += remainingWidth
    } else if (textAlign === 'center') {
      leftOffset += remainingWidth / 2
    } else if (textAlign === 'justify') {
      const line = wordsInLayout[i].line
      // Don't justify the last line.
      if (line < lineWidth.length - 1) {
        const segments = lineSegmentNumber[line]
        const gutter = segments > 1 ? remainingWidth / (segments - 1) : 0
        leftOffset += gutter * wordsInLayout[i].lineIndex
      }
    }

    if (graphemeImages && graphemeImages[word]) {
      image = graphemeImages[word]
    } else if (embedFont) {
      path = font.getSVG(resolvedFont, word, {
        ...parentStyle,
        left: left + leftOffset,
        top: top + topOffset,
        letterSpacing: parentStyle.letterSpacing,
      } as any)
    } else {
      // We need manually add the font ascender height to ensure it starts
      // at the baseline because <text>'s alignment baseline is set to `hanging`
      // by default and supported to change in SVG 1.1.
      topOffset += ascent
    }

    let filter = ''
    if (parentStyle.textShadowOffset) {
      filter = shadow(
        { width, height, id },
        {
          shadowColor: parentStyle.textShadowColor,
          shadowOffset: parentStyle.textShadowOffset,
          shadowRadius: parentStyle.textShadowRadius,
        }
      )
    }

    result += text(
      {
        content: word,
        filter,
        id,
        left: left + leftOffset,
        top: top + topOffset,
        width,
        height,
        isInheritingTransform,
        path,
        image,
        debug,
      },
      parentStyle
    )
  }

  return result
}
