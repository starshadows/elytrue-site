import { createApp } from 'vue'
import ImgViewer from './ImgViewer.vue'

export default createApp(ImgViewer).mount('#imgViewer') as InstanceType<
  typeof ImgViewer
>
