
export interface Point {
    x: number
    y: number
    subtract: (point: Point) => Vector
    mid: (point: Point) => Point
    toString: () => string
}

export interface Vector {
    x: number
    y: number
    readonly length: number
    add: (vector: Vector) => Vector
    multiply: (number: number) => Vector
    toString: () => string
}

export function createPoint(x: number, y: number) {
    const self: Point = {
        x,
        y,
        subtract(point) {
            return createVector(self.x - point.x, self.y - point.y)
        },
        mid(point: Point) {
            return createPoint((self.x + point.x) / 2, (self.y + point.y) / 2)
        },
        toString() {
            return `(${self.x}, ${self.y})`
        },
    }
    return self
}

export function createPointFromTouch(touch: Touch) {
    return createPoint(touch.clientX, touch.clientY)
}

export function createVector(x: number, y: number) {
    const self: Vector = {
        x,
        y,
        get length() {
            return Math.sqrt(self.x * self.x + self.y * self.y)
        },
        add(vector) {
            return createVector(self.x + vector.x, self.y + vector.y)
        },
        multiply(number: number) {
            return createVector(self.x * number, self.y * number)
        },
        toString() {
            return `(${self.x}, ${self.y})`
        },
    }
    return self
}

export function createPinchZoomController(touch1: Touch, touch2: Touch) {
    const self = {
        startPoint1: createPointFromTouch(touch1),
        startPoint2: createPointFromTouch(touch2),

        get startMidPoint() {
            return self.startPoint1.mid(this.startPoint2)
        },
        get startDistance() {
            return self.startPoint1.subtract(self.startPoint2).length
        },

        x: 0,
        y: 0,
        scale: 1,

        calcZoom(touch1: Touch, touch2: Touch) {
            const endPoint1 = createPointFromTouch(touch1)
            const endPoint2 = createPointFromTouch(touch2)
            const vector = endPoint1.subtract(self.startPoint1).add(endPoint2.subtract(self.startPoint2)).multiply(0.5)

            self.x = vector.x
            self.y = vector.y
            self.scale = endPoint1.subtract(endPoint2).length / self.startDistance
        },
    }
    return self
}

export function getWindowCenterPoint() {
    return createPoint(window.innerWidth / 2, window.innerHeight / 2)
}

/** Calculate the final offset based on the scale origin (mouse pointer location, or the middle of two touches) */
export function calcNewOffset(oldImgOffsetX: number, oldImgOffsetY: number, newScale: number, scaleOrigin: Point) {
    let x = oldImgOffsetX
    let y = oldImgOffsetY

    const centerBasedVector = scaleOrigin.subtract(getWindowCenterPoint())
    x += (newScale - 1) * (x - centerBasedVector.x)
    y += (newScale - 1) * (y - centerBasedVector.y)

    return { x, y }
}
