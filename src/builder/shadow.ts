// @TODO: It seems that SVG filters are pretty expensive for resvg, PNG
// generation time 10x'd when adding this filter (WASM in browser).
// https://drafts.fxtf.org/filter-effects/#feGaussianBlurElement

import { buildXMLString } from '../utils'

function shiftPath(path: string, dx: number, dy: number) {
  return path.replace(
    /([MA])([0-9.-]+),([0-9.-]+)/g,
    function (_, command, x, y) {
      return command + (parseFloat(x) + dx) + ',' + (parseFloat(y) + dy)
    }
  )
}

export function dropShadow(
  { id, width, height }: { id: string; width: number; height: number },
  style: Record<string, any>
) {
  if (
    !style.shadowColor ||
    !style.shadowOffset ||
    typeof style.shadowRadius === 'undefined'
  ) {
    return ''
  }

  // Expand the area for the filter to prevent it from cutting off.
  const grow = (style.shadowRadius * style.shadowRadius) / 4

  const left = Math.min(style.shadowOffset.width - grow, 0)
  const right = Math.max(style.shadowOffset.width + grow + width, width)
  const top = Math.min(style.shadowOffset.height - grow, 0)
  const bottom = Math.max(style.shadowOffset.height + grow + height, height)

  return `<defs><filter id="satori_s-${id}" x="${(left / width) * 100}%" y="${
    (top / height) * 100
  }%" width="${((right - left) / width) * 100}%" height="${
    ((bottom - top) / height) * 100
  }%"><feDropShadow dx="${style.shadowOffset.width}" dy="${
    style.shadowOffset.height
  }" stdDeviation="${
    // According to the spec, we use the half of the blur radius as the standard
    // deviation for the filter.
    // > the image that would be generated by applying to the shadow a Gaussian
    // > blur with a standard deviation equal to half the blur radius
    // > https://www.w3.org/TR/css-backgrounds-3/#shadow-blur
    style.shadowRadius / 2
  }" flood-color="${style.shadowColor}" flood-opacity="1"/></filter></defs>`
}

export function boxShadow(
  {
    width,
    height,
    shape,
    opacity,
    id,
  }: {
    width: number
    height: number
    shape: string
    opacity: number
    id: string
  },
  style: Record<string, any>
) {
  if (!style.boxShadow) return null

  let shadow = ''
  let innerShadow = ''

  for (let i = style.boxShadow.length - 1; i >= 0; i--) {
    let s = ''

    const shadowStyle = style.boxShadow[i]

    if (shadowStyle.spreadRadius && shadowStyle.inset) {
      shadowStyle.spreadRadius = -shadowStyle.spreadRadius
    }

    // Expand the area for the filter to prevent it from cutting off.
    const grow =
      (shadowStyle.blurRadius * shadowStyle.blurRadius) / 4 +
      (shadowStyle.spreadRadius || 0)

    const left = Math.min(
      -grow - (shadowStyle.inset ? shadowStyle.offsetX : 0),
      0
    )
    const right = Math.max(
      grow + width - (shadowStyle.inset ? shadowStyle.offsetX : 0),
      width
    )
    const top = Math.min(
      -grow - (shadowStyle.inset ? shadowStyle.offsetY : 0),
      0
    )
    const bottom = Math.max(
      grow + height - (shadowStyle.inset ? shadowStyle.offsetY : 0),
      height
    )

    const sid = `satori_s-${id}-${i}`
    const maskId = `satori_ms-${id}-${i}`
    const shapeWithSpread = shadowStyle.spreadRadius
      ? shape.replace(
          'stroke-width="0"',
          `stroke-width="${shadowStyle.spreadRadius * 2}"`
        )
      : shape

    s += buildXMLString(
      'mask',
      {
        id: maskId,
        maskUnits: 'userSpaceOnUse',
      },
      buildXMLString('rect', {
        x: 0,
        y: 0,
        width: style._viewportWidth,
        height: style._viewportHeight,
        fill: shadowStyle.inset ? '#000' : '#fff',
      }) +
        shapeWithSpread
          .replace(
            'fill="#fff"',
            shadowStyle.inset ? 'fill="#fff"' : 'fill="#000"'
          )
          .replace('stroke="#fff"', '')
    )

    let finalShape = shapeWithSpread
      .replace(/d="([^"]+)"/, (_, path) => {
        return (
          'd="' +
          shiftPath(path, shadowStyle.offsetX, shadowStyle.offsetY) +
          '"'
        )
      })
      .replace(/x="([^"]+)"/, (_, x) => {
        return 'x="' + (parseFloat(x) + shadowStyle.offsetX) + '"'
      })
      .replace(/y="([^"]+)"/, (_, y) => {
        return 'y="' + (parseFloat(y) + shadowStyle.offsetY) + '"'
      })

    // Negative spread radius, we need another mask here.
    if (shadowStyle.spreadRadius && shadowStyle.spreadRadius < 0) {
      s += buildXMLString(
        'mask',
        {
          id: maskId + '-neg',
          maskUnits: 'userSpaceOnUse',
        },
        finalShape
          .replace('stroke="#fff"', 'stroke="#000"')
          .replace(
            /stroke-width="[^"]+"/,
            `stroke-width="${-shadowStyle.spreadRadius * 2}"`
          )
      )
    }

    if (shadowStyle.spreadRadius && shadowStyle.spreadRadius < 0) {
      finalShape = buildXMLString(
        'g',
        {
          mask: `url(#${maskId}-neg)`,
        },
        finalShape
      )
    }

    s +=
      buildXMLString(
        'defs',
        {},
        buildXMLString(
          'filter',
          {
            id: sid,
            x: `${(left / width) * 100}%`,
            y: `${(top / height) * 100}%`,
            width: `${((right - left) / width) * 100}%`,
            height: `${((bottom - top) / height) * 100}%`,
          },
          buildXMLString('feGaussianBlur', {
            // According to the spec, we use the half of the blur radius as the standard
            // deviation for the filter.
            // > the image that would be generated by applying to the shadow a Gaussian
            // > blur with a standard deviation equal to half the blur radius
            // > https://www.w3.org/TR/css-backgrounds-3/#shadow-blur
            stdDeviation: shadowStyle.blurRadius / 2,
            result: 'b',
          }) +
            buildXMLString('feFlood', {
              'flood-color': shadowStyle.color,
              in: 'SourceGraphic',
              result: 'f',
            }) +
            buildXMLString('feComposite', {
              in: 'f',
              in2: 'b',
              operator: shadowStyle.inset ? 'out' : 'in',
            })
        )
      ) +
      buildXMLString(
        'g',
        {
          mask: `url(#${maskId})`,
          filter: `url(#${sid})`,
          opacity: opacity,
        },
        finalShape
      )

    if (shadowStyle.inset) {
      innerShadow += s
    } else {
      shadow += s
    }
  }

  return [shadow, innerShadow]
}
