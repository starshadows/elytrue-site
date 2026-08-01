import { createApp } from 'vue'

import FloatMsgs from './FloatMsgs'
import ImgViewer from './ImgViewer'

import { app as PopupsApp } from './Popups'
import LoginPopup from './Popups/LoginPopup.vue'
import InputPopup from './Popups/InputPopup.vue'
import SetAvatarPopup from './Popups/SetAvatarPopup.vue'
import SetPasswordPopup from './Popups/SetPasswordPopup.vue'
import UserHome from './Popups/UserHome.vue'
import AdminPanel from './Popups/AdminPanel.vue'

import GraphicsMode from './GraphicsMode.vue'

PopupsApp.component('loginPopup', LoginPopup)
PopupsApp.component('promptInputPopup', InputPopup)
PopupsApp.component('setAvatarPopup', SetAvatarPopup)
PopupsApp.component('setPasswordPopup', SetPasswordPopup)
PopupsApp.component('userHome', UserHome)
PopupsApp.component('adminPanel', AdminPanel)

createApp(GraphicsMode).mount('#graphicsMode')

export default {
    FloatMsgs,
    ImgViewer,
} 
