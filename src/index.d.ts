import type XHR from './net/xhr'

export interface FloatMessageOptions {
  readonly type: 'success' | 'info' | 'warn' | 'error'
  readonly msg: string
  readonly persist?: boolean
}

export interface PopupController {
  show(id: string, props?: Record<string, unknown>): void
  close(): void
}

export interface UserController {
  LoggedOnUserId: string | null
  changeName(): void
  changeAvatar(): void
  changeEmail(): void
  changePassword(): void
  showMe(): void
  logout(): void
  resetToken(): void
  getMe(): Promise<unknown>
  convertAvatarPath(path?: string): string
}

export interface SiteSettings {
  lang: '' | 'zh' | 'en'
  pageScale: number
  showHidden: boolean
}

export interface InstallPrompt {
  prompt(): Promise<void>
}

export const XHR: typeof XHR
export const Settings: SiteSettings
export const User: UserController
export const Popup: PopupController
export const Comments: {
  forceLowerPanelUp(): void
  forceLowerPanelDown(): void
}
export const MusicPlayer: {
  play(): void
  pause(): void
  playNext(): void
  playPrev(): void
}
export const Theme: {
  set(theme: string): void
}
export const FloatMsgs: {
  show(options: FloatMessageOptions): void
}
export const hideTopCommentElmnt: HTMLInputElement | null
export const installPrompt: InstallPrompt | null
export const isInStandaloneMode: boolean

export function showPopup(id: string, props?: Record<string, unknown>): void
export function closePopup(): void
export function clearComments(clearTop?: number): void
export function loadComments(
  query?: Readonly<Record<string, unknown>>,
  keepPosition?: Element,
): Promise<unknown>
export function seekComment(direction: -1 | 1): void
export function newComment(): void | Promise<void>
export function cancelMessage(): void
export function sendMessage(): void | Promise<void>
export function previewLocalImgs(): void | Promise<void>
export function toggleFullscreen(): void
export function toggleTimeline(): void
export function toggleTopComment(): void
export function setConfig(key: string, value: string | boolean | number): void
export function loadUserInfo(): Promise<boolean>
export function logErr(error: unknown, message: string): void
export function viewImg(source: string): void
export function resizeImg(
  image: Blob,
  aspectRatio: number,
  maxPixels: number,
): Promise<string>
