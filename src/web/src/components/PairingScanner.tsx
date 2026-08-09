// In-app QR scanner for pairing (progressive enhancement).
//
// Uses the platform BarcodeDetector + a rear-camera stream to read the desktop
// Remote-access QR directly. It is strictly optional: when BarcodeDetector or a
// camera is unavailable the caller falls back to the always-present paste field,
// so nothing here is load-bearing. The camera track is always stopped on
// unmount or first hit, so leaving the scanner never leaves the camera on.

import { useEffect, useRef, useState } from 'react'
import { Button, Notice } from './ui'

/** Minimal shape of the platform BarcodeDetector we rely on. */
interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<Array<{ rawValue: string }>>
}
interface BarcodeDetectorCtor {
  new (options?: { formats?: string[] }): BarcodeDetectorLike
}

declare global {
  interface Window {
    BarcodeDetector?: BarcodeDetectorCtor
  }
}

/** Whether in-app scanning is available in this runtime. */
export function canScanPairing(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.BarcodeDetector === 'function' &&
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia
  )
}

/**
 * Live camera QR scanner. Calls `onCode` with the first decoded value, then
 * stops. Errors (permission denied, no camera) surface inline and the operator
 * closes back to the paste field.
 */
export function PairingScanner({
  onCode,
  onClose
}: {
  onCode: (code: string) => void
  onClose: () => void
}): JSX.Element {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const Detector = window.BarcodeDetector
    if (!Detector) {
      setError('Scanning is not supported on this device.')
      return
    }
    let stream: MediaStream | null = null
    let timer: number | undefined
    let stopped = false

    const stop = (): void => {
      stopped = true
      window.clearInterval(timer)
      stream?.getTracks().forEach((t) => t.stop())
    }

    const start = async (): Promise<void> => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' }
        })
        if (stopped) {
          stream.getTracks().forEach((t) => t.stop())
          return
        }
        const video = videoRef.current
        if (!video) return
        video.srcObject = stream
        await video.play()
        const detector = new Detector({ formats: ['qr_code'] })
        timer = window.setInterval(async () => {
          if (stopped || !videoRef.current) return
          try {
            const hits = await detector.detect(videoRef.current)
            const value = hits.find((h) => h.rawValue.startsWith('C1:'))?.rawValue
            if (value) {
              stop()
              onCode(value)
            }
          } catch {
            // A transient detect failure on one frame is fine; the next frame retries.
          }
        }, 350)
      } catch {
        setError('Could not open the camera. Grant camera access or paste the code instead.')
      }
    }

    void start()
    return stop
  }, [onCode])

  return (
    <div className="mt-3 flex flex-col gap-2">
      {error ? (
        <Notice tone="error">{error}</Notice>
      ) : (
        <video
          ref={videoRef}
          className="w-full rounded-md border border-edge bg-black"
          muted
          playsInline
        />
      )}
      <div className="flex justify-end">
        <Button variant="ghost" onClick={onClose}>
          Cancel scan
        </Button>
      </div>
    </div>
  )
}
