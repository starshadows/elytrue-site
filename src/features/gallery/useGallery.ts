import { viewImage } from '../../app/controller'

export function useGallery() {
  return {
    openImage: viewImage,
  }
}
