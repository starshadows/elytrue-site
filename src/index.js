import XHR from './net/xhr'
import Settings from './settings'
import { getCookie, setCookie, getConfig, setConfig } from './settings/config'
import { changeLang } from './settings/lang'
import FloatMsgs from './components/FloatMsgs'
import Popups from './components/Popups'
import ImgViewer from './components/ImgViewer'
import { addPullDownRefresh } from './components/controls/PullDownRefresh'
import { createApp } from 'vue'
import ProgressSlider from './components/controls/ProgressSlider.vue'
import { GallerySwipeController } from './components/controls/GallerySwiper'
import { toQueryString } from './lib/query'
import {
  BACKGROUNDS,
  BACKGROUND_GROUPS,
  DEFAULT_MUSIC,
  MUSIC_ROOT,
  OFFICIAL_MUSIC,
} from './config/assets'
const STATIC_SHOWCASE_MODE = false
const TIMELINE_START_DATE = new Date(2026, 7, 1)
const TIMELINE_START_MS = TIMELINE_START_DATE.getTime()
function finishCommentsLoading() {
  document
    .getElementById('loadingIndicatorBefore')
    ?.style.setProperty('display', 'none')
  document
    .getElementById('loadingIndicator')
    ?.style.setProperty('display', 'none')
}
function loadComments(queryObj = {}, keepPosEl = void 0) {
  var isCommentsNewer = queryObj.from > getMaxCommentID()
  var isCommentsOlder = queryObj.from < getMinCommentID()
  return XHR.get('comments', queryObj)
    .then((response) => {
      const truncated = !Array.isArray(response) && response?.hasMore === true
      const items = Array.isArray(response) ? response : response?.items || []
      if (items.length == 0) {
        if (document.getElementsByClassName('commentItem').length == 0) {
          finishCommentsLoading()
          Comments.upToDate = true
          return
        }
        if (isCommentsNewer) {
          document.getElementById('loadingIndicatorBefore').style.display =
            'none'
          Comments.upToDate = true
          return
        }
        if (isCommentsOlder) {
          if (!truncated) {
            document.getElementById('loadingIndicator').style.display = 'none'
          }
          return
        }
        if (
          queryObj.from &&
          document.getElementsByClassName('commentItem').length == 0
        ) {
          document.getElementById('loadingIndicatorBefore').style.display =
            'none'
        }
        return
      }
      if (items[0].time > maxTimelineTime) {
        maxTimelineTime = items[0].time
        loadTimeline(maxTimelineTime)
        setTodayCommentCount()
      }
      var keepPos = items[0].time > getMaxCommentTime() || keepPosEl != void 0
      if (keepPosEl == void 0) {
        keepPosEl = getFirstVisibleComment()
      }
      var prevCommentTop = keepPosEl.getBoundingClientRect().top
      var prevCommentLeft = keepPosEl.getBoundingClientRect().left
      for (let comment of items) insertComment(comment)
      if (keepPos && document.getElementById('topComment') == null) {
        if (isFullscreen) {
          var newCommentTop = keepPosEl.getBoundingClientRect().top
          commentDiv.scrollTop += newCommentTop - prevCommentTop
        } else {
          var newCommentLeft = keepPosEl.getBoundingClientRect().left
          commentDiv.scrollLeft += newCommentLeft - prevCommentLeft
        }
      }
      setTimelineActiveMonth(true)
      document
        .getElementById('loadingIndicatorBefore')
        ?.style.setProperty('display', 'none')
      const requestedCount = Math.min(
        100,
        Math.max(1, Math.abs(Number(queryObj.count ?? 30))),
      )
      if (!isCommentsNewer && items.length < requestedCount && !truncated) {
        document
          .getElementById('loadingIndicator')
          ?.style.setProperty('display', 'none')
      }
    })
    .catch(() => {
      finishCommentsLoading()
    })
}
function insertComment(comment) {
  var insertBeforeEl = null
  function compareCommentAt(i) {
    return compareArr(
      [comment.time, comment.id],
      [
        parseInt(commentList[i].dataset.timestamp),
        parseInt(commentList[i].id.replace('#', '')),
      ],
    )
  }
  var commentList = document.getElementsByClassName('commentItem')
  if (commentList.length == 0) {
    insertBeforeEl = document.getElementById('loadingIndicator')
  } else {
    if (compareCommentAt(0) > 0) {
      insertBeforeEl = commentList[0]
    } else if (compareCommentAt(commentList.length - 1) < 0) {
      insertBeforeEl = document.getElementById('loadingIndicator')
    } else {
      for (let i = 0; i < commentList.length - 1; i++) {
        if (compareCommentAt(i) < 0 && compareCommentAt(i + 1) > 0) {
          insertBeforeEl = commentList[i + 1]
          break
        }
      }
    }
  }
  if (insertBeforeEl == null) {
    return
  }
  var time = new Date(comment.time * 1e3)
  var date = time.toLocaleDateString()
  var hour = time.toLocaleTimeString()
  var randBG
  while (true) {
    randBG = getRandomIntInclusive(1, msgBgCount)
    if (!lastBgImgs.includes(randBG)) {
      break
    }
  }
  lastBgImgs.push(randBG)
  if (lastBgImgs.length > 5) {
    lastBgImgs.splice(0, 1)
  }
  let commentExtra = ''
  try {
    if (comment.image != '') {
      for (let i of comment.image.split(',')) {
        commentExtra +=
          /*html*/
          `<img loading="lazy" src="/api/data/images/posts/${i}.jpg" data-action="view-image" data-lift-panel="true">`
      }
    }
  } catch (error) {
    void error
  }
  if (commentExtra) commentExtra = '<br><br>' + commentExtra
  if (comment.replyid) {
    commentExtra = '<br><div class="reply-quote"></div>' + commentExtra
  }
  const displayId = comment.displayId ?? comment.id
  const canReport =
    User.LoggedOnUserId != null && User.LoggedOnUserId != comment.uid
  let commentEl = html2elmnt(
    /*html*/
    `
        <div class="commentBox commentItem${comment.hidden ? ' hidden' : ''}" id="#${comment.id}" data-uid="${htmlEscape(comment.uid)}" data-number="${displayId}" data-timestamp="${comment.time}">
            <img class="bg" loading="lazy" src="${msgBgInfo[randBG - 1].src}" ${comment.hidden == 1 ? 'style="display: none;"' : ''}>
            <div class="bgcover"></div>
            <img class="avatar" loading="lazy" src="${User.convertAvatarPath(comment.avatar)}">
            <div class="sender" data-action="click-previous">
                ${comment.sender == '\u533F\u540D\u7528\u6237' ? '<span class="ui zh">\u533F\u540D\u7528\u6237</span><span class="ui en">Anonymous</span>' : htmlEscape(comment.sender)}
            </div>
            <div class="id">#${displayId}</div>
            <div class="comment">${htmlEscape(comment.comment)}${commentExtra}</div>
            <div class="time">${date + ' ' + hour}${comment.hidden == 1 ? ' (hidden)' : ''}</div>
            <div class="action">
                <span class="btn like">
                    <span class="like-count"></span>
                </span>
                <img class="btn reply" src="/res/reply.svg">
                ${canReport ? '<span class="btn report"><span class="ui zh">\u4E3E\u62A5</span><span class="ui en">Report</span></span>' : ''}
            </div>
        </div>
    `,
  )
  commentEl.querySelector('.avatar').onclick = function () {
    if (comment.uid != null) {
      Popup.show('userHome', {
        id: comment.uid,
        name: comment.sender,
        avatar: comment.avatar,
      })
    }
    Comments.forceLowerPanelUp()
  }
  let newComment2 = {
    /** @type {HTMLSpanElement} */
    likeBtn: commentEl.querySelector('.btn.like'),
    /** @type {HTMLSpanElement} */
    likeCount: commentEl.querySelector('.like-count'),
    /** @type {HTMLImageElement} */
    replyBtn: commentEl.querySelector('.btn.reply'),
    /** @type {HTMLDivElement} */
    replyQuote: commentEl.querySelector('.reply-quote'),
    likeBusy: false,
    /** 点击时的服务端快照,失败时回滚用 */
    lastKnownLiked: comment.liked,
    lastKnownLikes: comment.likes,
    get liked() {
      return this.likeBtn.classList.contains('liked')
    },
    set liked(value) {
      value
        ? this.likeBtn.classList.add('liked')
        : this.likeBtn.classList.remove('liked')
    },
    get likes() {
      return parseInt(this.likeCount.textContent) || 0
    },
    set likes(value) {
      this.likeCount.textContent = value
      this.likeCount.style.display = value ? 'block' : 'none'
    },
    init() {
      this.liked = comment.liked
      this.likes = comment.likes
      this.likeBtn.onclick = async () => {
        if (this.likeBusy) return
        if (!(await User.ensureLoggedIn())) return
        this.likeBusy = true
        this.likeBtn.classList.add('busy')
        this.lastKnownLiked = this.liked
        this.lastKnownLikes = this.likes
        try {
          await (this.liked
            ? XHR.delete(`comments/like?commentId=${comment.id}`)
            : XHR.post(`comments/like?commentId=${comment.id}`))
          const r = await XHR.get('comments', { from: comment.id, count: 1 })
          if (r[0]) {
            this.liked = r[0].liked
            this.likes = r[0].likes
          }
        } catch (error) {
          this.liked = this.lastKnownLiked
          this.likes = this.lastKnownLikes
        } finally {
          this.likeBusy = false
          this.likeBtn.classList.remove('busy')
        }
      }
      this.replyBtn.onclick = async () => {
        if (!(await User.ensureLoggedIn())) return
        NewMessage.reply(comment.number ?? comment.id)
      }
      const reportBtn = commentEl.querySelector('.btn.report')
      if (reportBtn) {
        bindReportButton(reportBtn, comment, displayId)
      }
      if (comment.replyid) {
        initCommentReplyQuote(this.replyQuote, comment.replyid, {
          clickable: true,
        })
      }
    },
  }
  newComment2.init()
  commentDiv.insertBefore(commentEl, insertBeforeEl)
}
function bindReportButton(reportBtn, comment, displayId) {
  reportBtn.onclick = async () => {
    if (!(await User.ensureLoggedIn())) return
    Popup.show('promptInputPopup', {
      title:
        /*html*/
        `
                <span class="ui zh">\u4E3E\u62A5\u7559\u8A00 #${displayId}</span>
                <span class="ui en">Report message #${displayId}</span>
            `,
      subtitle:
        /*html*/
        `
                <span class="ui zh">\u8BF7\u7B80\u8981\u63CF\u8FF0\u4E3E\u62A5\u539F\u56E0,\u7BA1\u7406\u5458\u6838\u5B9E\u540E\u4F1A\u5904\u7406\u3002</span>
                <span class="ui en">Please describe the reason briefly. Moderators will review it.</span>
            `,
      action(reason, context) {
        context.setDisabled(true)
        XHR.post('comments/report', { commentId: comment.id, reason })
          .then((r) => {
            if (r.code == 1) {
              context.close()
              FloatMsgs.show({
                type: 'success',
                persist: true,
                msg:
                  /*html*/
                  `
                            <span class="ui zh">\u4E3E\u62A5\u5DF2\u63D0\u4EA4,\u611F\u8C22\u53CD\u9988</span>
                            <span class="ui en">Report submitted. Thank you.</span>`,
              })
            }
          })
          .finally(() => {
            context.setDisabled(false)
          })
      },
    })
  }
}
function refreshCommentActions() {
  Array.from(document.getElementsByClassName('commentItem')).forEach((el) => {
    const commentId = Number(String(el.id).replace(/^#/, ''))
    const uid = el.dataset.uid
    const displayId = Number(el.dataset.number || commentId)
    if (!commentId || !uid) return
    const shouldShow = User.LoggedOnUserId != null && User.LoggedOnUserId != uid
    const existing = el.querySelector('.btn.report')
    if (shouldShow && !existing) {
      const actionEl = el.querySelector('.action')
      if (!actionEl) return
      const reportBtn = html2elmnt(
        '<span class="btn report"><span class="ui zh">\u4E3E\u62A5</span><span class="ui en">Report</span></span>',
      ).firstElementChild
      bindReportButton(
        reportBtn,
        { id: commentId, number: displayId },
        displayId,
      )
      actionEl.appendChild(reportBtn)
    } else if (!shouldShow && existing) {
      existing.remove()
    }
  })
}
function initCommentReplyQuote(el, id, params) {
  XHR.get('comments', { from: id, count: 1 }).then((r) => {
    let comment = r[0]
    el.$comment = comment
    el.innerHTML =
      /*html*/
      `
            <img class="reply-icon" src="/res/reply.svg">
            <div class="quote-content">
                <div class="quote-head">
                    <img class="quote-avatar" src="${User.convertAvatarPath(comment.avatar)}">
                    <div class="quote-sender">${htmlEscape(comment.sender)}</div>
                    <div class="quote-id">#${comment.displayId ?? comment.id}</div>
                </div>
                <div class="quote-body">${htmlEscape(comment.comment)}</div>
            </div>
        `
    el.classList.add('comment-reply-quote')
    el.contentEditable = false
    if (params.clickable) {
      el.classList.add('clickable')
      el.onclick = () => {
        clearComments(1)
        loadComments({ number: comment.number ?? comment.id })
      }
    }
    if (params.dark) el.classList.add('dark')
  })
}
function clearComments(clearTop) {
  if (clearTop == 1) {
    commentDiv.innerHTML = loadingIndicatorBefore + loadingIndicator
  } else {
    commentDiv.innerHTML =
      topComment + loadingIndicatorBefore + loadingIndicator
    document.getElementById('loadingIndicatorBefore').style.display = 'none'
  }
  Comments.scrollPaused = false
  Comments.upToDate = false
  document.body.classList.remove('touchKeyboardShowing')
}
function loadOlderComments() {
  if (getMinCommentID() != null && getMinCommentID() > 1) {
    loadComments({ from: getMinCommentID() - 1 })
  }
}
function loadNewerComments() {
  if (
    document.getElementById('newCommentBox') != null &&
    document.getElementById('topComment') == null
  ) {
    document.getElementById('loadingIndicatorBefore').style.display = 'none'
    return
  }
  var count = 10
  if (isFullscreen) {
    count = getFullscreenHorizonalCommentCount() * 2
    while (count < 9) {
      count += getFullscreenHorizonalCommentCount()
    }
    commentDiv.scrollTop = 0
  }
  if (getMaxCommentID() == null) {
    loadComments({ time: getMaxCommentTime() }, getFirstVisibleComment())
  } else {
    loadComments({ from: getMaxCommentID() + 1, count: 0 - count })
  }
}
function getMaxCommentID() {
  var commentList = document.querySelectorAll('.commentItem[id^="#"]')
  if (commentList.length > 0)
    return parseInt(commentList[0].id.replace('#', ''))
}
function getMinCommentID() {
  var commentList = document.querySelectorAll('.commentItem[id^="#"]')
  if (commentList.length > 0)
    return parseInt(commentList[commentList.length - 1].id.replace('#', ''))
}
function getMaxCommentTime() {
  var commentList = document.querySelectorAll('.commentItem')
  if (commentList.length > 0) return parseInt(commentList[0].dataset.timestamp)
}
function getMinCommentTime() {
  var commentList = document.querySelectorAll('.commentItem')
  if (commentList.length > 0)
    return parseInt(commentList[commentList.length - 1].dataset.timestamp)
}
function getFirstVisibleComment() {
  return (
    document.querySelector('.commentItem:not(.hidden)') ||
    document.getElementById('loadingIndicatorBefore').nextElementSibling
  )
}
const NewMessage = {
  async show() {
    if (!(await User.ensureLoggedIn())) {
      FloatMsgs.show({
        type: 'info',
        msg: '<span class="ui zh">\u767B\u5F55\u540E\u5373\u53EF\u7559\u8A00\u3001\u56DE\u590D\u548C\u4E0A\u4F20\u56FE\u7247</span><span class="ui en">Log in to post, reply and upload images</span>',
      })
      return
    }
    commentDiv.scrollLeft = 0
    commentDiv.scrollTop = 0
    if (document.getElementById('newCommentBox')) {
      document.getElementById('msgText').focus({ preventScroll: true })
      return
    }
    commentDiv.insertBefore(
      html2elmnt(
        /*html*/
        `
            <div class="commentBox" id="newCommentBox">
                <div class="bgcover"></div>
                <img class="avatar" id="msgPopupAvatar" data-action="user-change-avatar">
                <div class="sender" id="senderText" data-action="user-change-name"></div>
                <div class="id" data-action="show-login"><span class="ui zh">\u6CE8\u518C/\u767B\u5F55</span><span class="ui en">Login / Register</span></div>
                <div class="comment">
                    <div id="msgText" placeholder="\u613F\u82B1\u4E0E\u661F\u8F89\u4F34\u4F60\u540C\u884C\u266A" contenteditable="true"></div>
                    <div id="uploadImgList"></div>
                </div>
                <label>
                    <input id="uploadImgPicker" type="file" accept="image/*" data-action="preview-local-images" multiple style="display: none;" />
                    <span><span class="ui zh">+ \u6DFB\u52A0\u56FE\u7247</span><span class="ui en">+ Add images</span></span>
                </label>
                <div class="messageActions">
                    <button id="cancelSendBtn" data-action="cancel-message"><span class="ui zh">\u53D6\u6D88\u53D1\u9001</span><span class="ui en">Cancel</span></button>
                    <button id="sendBtn" data-action="send-message"><span class="ui zh">\u53D1\u9001 \u2714</span><span class="ui en">Send \u2714</span></button>
                </div>
            </div>
        `,
      ),
      commentDiv.firstElementChild,
    )
    const editor = document.getElementById('msgText')
    editor.addEventListener('focus', () => {
      Comments.forceLowerPanelUp()
      TouchKeyboardDetector.detect()
    })
    editor.addEventListener('blur', () => TouchKeyboardDetector.detect())
    editor.focus({ preventScroll: true })
  },
  previewLocalImgs() {
    var imgUploadInput = document.getElementById('uploadImgPicker')
    if (imgUploadInput.files.length === 0) {
      return
    }
    const remaining = Math.max(
      0,
      3 - document.getElementsByClassName('uploadImg').length,
    )
    if (remaining == 0) {
      FloatMsgs.show({
        type: 'warn',
        msg: '<span class="ui zh">\u6BCF\u6761\u7559\u8A00\u6700\u591A\u4E0A\u4F20 3 \u5F20\u56FE\u7247</span><span class="ui en">Up to 3 images per message</span>',
      })
      imgUploadInput.value = ''
      return
    }
    for (let i = 0; i < Math.min(imgUploadInput.files.length, remaining); i++) {
      resizeImg(imgUploadInput.files[i], null, 2.1 * 1e3 * 1e3).then((i2) => {
        document.getElementById('uploadImgList').appendChild(
          html2elmnt(
            /*html*/
            `
                    <div>
                        <img src="${i2}" class="uploadImg" data-action="view-image">
                        <button data-action="remove-upload">\u274C</button>
                    </div>
                `,
          ),
        )
      })
    }
    imgUploadInput.value = ''
  },
  async reply(id) {
    if (!document.getElementById('newCommentBox')) {
      await this.show()
      if (!document.getElementById('newCommentBox')) return
    }
    let msgText = document.getElementById('msgText')
    this.removeReply()
    let quoteEl = html2elmnt(`<div id="newCommentReplyQuote"></div>`)
    if (!this.getNewMessage()) {
      msgText.appendChild(html2elmnt(`<div><br></div>`))
    }
    msgText.appendChild(quoteEl)
    initCommentReplyQuote(this.getReplyQuote(), id, { dark: true })
    await this.show()
  },
  removeReply() {
    let el = this.getReplyQuote()
    el && el.remove()
  },
  getReplyQuote() {
    return document.getElementById('newCommentReplyQuote')
  },
  getReplyId() {
    let quote = this.getReplyQuote()
    return quote ? quote.$comment.id : void 0
  },
  getNewMessage() {
    let replyQuote = this.getReplyQuote()
    replyQuote && (replyQuote.style.display = 'none')
    let message = document.getElementById('msgText').innerText
    replyQuote && replyQuote.style.removeProperty('display')
    return message
  },
  cancel() {
    const editor = document.getElementById('newCommentBox')
    if (!editor || editor.classList.contains('closing')) return
    const removeEditor = () => {
      if (!editor.isConnected) return
      editor.remove()
    }
    const finishDismissAnimation = (event) => {
      if (
        event.target !== editor ||
        event.animationName !== 'newCommentBoxCollapse'
      )
        return
      editor.removeEventListener('animationend', finishDismissAnimation)
      removeEditor()
    }
    editor
      .querySelectorAll('button')
      .forEach((button) => (button.disabled = true))
    document.getElementById('msgText')?.blur()
    editor.classList.add('closing')
    editor.addEventListener('animationend', finishDismissAnimation)
    setTimeout(removeEditor, 1200)
    document.body.classList.remove('touchKeyboardShowing')
    Comments.forceLowerPanelDown()
  },
  async send() {
    if (!(await User.ensureLoggedIn())) return
    let replyid = this.getReplyId()
    let msg = this.getNewMessage()
    var imgList = []
    var uploadImgClass = document.getElementsByClassName('uploadImg')
    if (uploadImgClass.length > 0) {
      for (let i = 0; i < uploadImgClass.length; i++) {
        const imgElmnt = uploadImgClass[i]
        imgList.push(imgElmnt.src.split(';base64,')[1])
      }
    }
    if (msg.replace(/\s/g, '') == '') {
      FloatMsgs.show({
        type: 'warn',
        msg: '<span class="ui zh">\u7559\u8A00\u4E0D\u80FD\u4E3A\u7A7A!</span><span class="ui en">Do not leave the message empty!</span>',
      })
      return
    }
    document.getElementById('sendBtn').disabled = true
    document.getElementById('sendBtn').innerHTML =
      '<span class="ui zh">\u6B63\u5728\u53D1\u9001\u2026</span><span class="ui en">Sending\u2026</span>'
    const uploaded = []
    try {
      for (const image of imgList) {
        const result = await XHR.post('uploads/image', { image })
        uploaded.push(result.data.imageId)
      }
      await XHR.post('comments/post', {
        comment: msg,
        imageKeys: uploaded,
        replyid,
      })
    } catch (error) {
      if (uploaded.length > 0) {
        Promise.allSettled(
          uploaded.map((imageId) =>
            XHR.delete(`uploads/image?imageId=${imageId}`, void 0, {
              silentStatuses: [404, 409],
            }),
          ),
        )
      }
      window.alert(
        '\u53D1\u9001\u7559\u8A00\u5931\u8D25\uFF0C\u8BF7\u786E\u8BA4\u672C\u5730\u540E\u7AEF\u4ECD\u5728\u8FD0\u884C\u540E\u91CD\u8BD5\u3002\n\nFailed to send the message. Please make sure the local backend is running and try again.',
      )
      document.getElementById('sendBtn').disabled = false
      document.getElementById('sendBtn').innerHTML =
        '<span class="ui zh">\u53D1\u9001 \u2714</span><span class="ui en">Send \u2714</span>'
      return
    }
    document.getElementById('sendBtn').innerHTML =
      '<span class="ui zh">\u53D1\u9001\u6210\u529F!</span><span class="ui en">Sent!</span>'
    setTimeout(() => {
      clearComments()
      loadComments().finally(finishCommentsLoading)
    }, 1e3)
  },
}
var newComment = NewMessage.show.bind(NewMessage)
var cancelMessage = NewMessage.cancel.bind(NewMessage)
var sendMessage = NewMessage.send.bind(NewMessage)
var previewLocalImgs = NewMessage.previewLocalImgs.bind(NewMessage)
const Popup = {
  elements: {
    popupContainer: document.getElementById('popupContainer'),
    popupItems: Array.from(
      document.querySelectorAll('#popupContainer .popupItem'),
    ),
  },
  VuePopups: Popups,
  pendingClose: false,
  hideAllPopupItems() {
    this.elements.popupItems.forEach((el) => {
      el.style.display = 'none'
    })
  },
  show(popupID, props) {
    setTimeout(() => {
      if (!(
        location.hash.startsWith('#popup-') ||
        location.hash.startsWith('#resetpassword=')
      )) {
        location.hash = 'popup'
      }
      document.documentElement.style.setProperty(
        '--popupFromTranslateX',
        `${lastClickEvent ? lastClickEvent.pageX - window.innerWidth / 2 : 0}px`,
      )
      document.documentElement.style.setProperty(
        '--popupFromTranslateY',
        `${lastClickEvent ? lastClickEvent.pageY - window.innerHeight / 2 : 0}px`,
      )
      let popup = document.getElementById(popupID)
      if (!popup) {
        this.VuePopups.show(popupID, props)
        return
      }
      this.elements.popupContainer.classList.remove('closing')
      this.pendingClose = false
      this.hideAllPopupItems()
      this.elements.popupContainer.style.removeProperty('display')
      popup.style.removeProperty('display')
      switch (popupID) {
        case 'getImgPopup':
          document.getElementById(
            'getImgPopup',
          ).firstElementChild.lastElementChild.innerHTML = ''
          BACKGROUND_GROUPS.forEach((group) => {
            const backgrounds = BACKGROUNDS.filter(
              (background) => background.layout === group.layout,
            )
            if (!backgrounds.length) return
            document
              .getElementById('getImgPopup')
              .firstElementChild.lastElementChild.appendChild(
                html2elmnt(
                  /*html*/
                  `
                            <h3 class="backgroundGroupTitle">
                                <span class="ui zh">${group.title.zh}</span><span class="ui en">${group.title.en}</span>
                            </h3>
                        `,
                ),
              )
            backgrounds.forEach((background) => {
              document
                .getElementById('getImgPopup')
                .firstElementChild.lastElementChild.appendChild(
                  html2elmnt(
                    /*html*/
                    `
                                <img loading="lazy" decoding="async" src="${background.preview}" style="min-height: 40vh;" data-action="background-loaded">
                                <p>
                                    ${
                                      background.creditUrl
                                        ? `
                                        <span class="authorizedRepost"><span class="ui zh">\u7ECF\u4F5C\u8005\u8BB8\u53EF\u8F6C\u8F7D</span><span class="ui en">Reposted with permission</span> \xB7 </span>
                                    `
                                        : ''
                                    }
                                    <span class="ui zh">${background.credit.zh}</span><span class="ui en">${background.credit.en}</span>
                                    ${
                                      background.creditUrl
                                        ? `
                                        <a href="${background.creditUrl}" target="_blank" rel="noopener noreferrer">\u56FE\u6E90\u2197</a>
                                    `
                                        : ''
                                    }
                                    ${
                                      background.original
                                        ? `
                                        <a class="downloadOriginal" href="${background.original}" download>
                                            <span class="ui zh">\u4E0B\u8F7D\u539F\u56FE</span><span class="ui en">Download original</span> \u2193
                                        </a>
                                    `
                                        : ''
                                    }
                                </p>
                                <br>
                            `,
                  ),
                )
            })
          })
          break
        case 'displaySettings':
          document.getElementById('pageZoomController').value = Math.round(
            Settings.pageScale * 100,
          )
          break
        default:
          break
      }
    }, 35)
  },
  close() {
    if (location.hash == '#popup') {
      history.back()
      return
    }
    this.elements.popupContainer.classList.add('closing')
    this.pendingClose = true
    setTimeout(() => {
      if (this.pendingClose) {
        this.elements.popupContainer.style.display = 'none'
        this.hideAllPopupItems()
      }
    }, 150)
    this.VuePopups.close()
  },
  isOpen() {
    return (
      this.elements.popupContainer.style.display != 'none' ||
      this.VuePopups.popups.length > 0
    )
  },
  init() {
    this.elements.popupContainer.onclick = (e) => {
      if (e.target.classList.contains('closeBtn') || e.target.id == 'popupBG') {
        this.close()
      }
    }
  },
}
var showPopup = Popup.show.bind(Popup)
var closePopup = Popup.close.bind(Popup)
try {
  Popup.init()
} catch (error) {
  logErr(error, 'failed to init popup')
}
const User = {
  LoggedOnUserId: null,
  /** 'loading' | 'authenticated' | 'unauthenticated' */
  loginState: 'loading',
  _initPromise: null,
  init() {
    XHR.token = ''
    XHR.csrfToken = ''
    this._initPromise = this.loadUserInfo()
  },
  /**
   * 登录状态初始化完成前的等待点。
   * 单飞:多次调用复用同一个 /user/me 请求。
   */
  ready() {
    if (!this._initPromise) this._initPromise = this.loadUserInfo()
    return this._initPromise
  },
  async ensureLoggedIn() {
    if (this.loginState === 'loading') await this.ready()
    if (!this.LoggedOnUserId) {
      Popup.show('loginPopup')
      return false
    }
    return true
  },
  changeName() {
    this.getMe().then((r) =>
      Popup.show('promptInputPopup', {
        title:
          '<span class="ui zh">\u4FEE\u6539\u6635\u79F0</span><span class="ui en">Change nickname</span>',
        subtitle:
          /*html*/
          `
                    <span class="ui zh">${r.hasEmail ? '' : '\u66F4\u6539\u540E, <b>\u5C06\u65E0\u6CD5\u4F7F\u7528\u65E7\u6635\u79F0\u767B\u5F55</b><br>\u8BF7\u786E\u4FDD\u8FD9\u662F\u60A8\u7684\u8D26\u53F7, \u518D\u8FDB\u884C\u4FEE\u6539, \u5426\u5219, \u8BF7\u5148\u521B\u5EFA\u4E00\u4E2A\u81EA\u5DF1\u7684\u8D26\u53F7<br><br>'}\u8F93\u5165\u65B0\u6635\u79F0</span>
                    <span class="ui en">${r.hasEmail ? '' : 'After changing, <b>you won&rsquo;t be able to log in with the old name.</b><br>Make sure this is your account, if not, create a new one.<br><br>'}Enter your new nickname</span>
                    `,
        text: r.name,
        action(name, context) {
          XHR.put('user/update', { name }).then((r2) => {
            if (r2.code == 1) {
              context.close()
              FloatMsgs.show({
                type: 'success',
                msg: '<span class="ui zh">\u4FEE\u6539\u6210\u529F</span><span class="ui en">Successfully changed</span>',
              })
              loadUserInfo()
            }
          })
        },
      }),
    )
  },
  changeEmail() {
    this.getMe().then((r) =>
      Popup.show('promptInputPopup', {
        title:
          '<span class="ui zh">\u4FEE\u6539\u90AE\u7BB1</span><span class="ui en">Change email</span>',
        subtitle:
          /*html*/
          `
                    <span class="ui zh">\u90AE\u7BB1\u7528\u4E8E\u767B\u5F55\u3001\u5BC6\u7801\u627E\u56DE\u548C\u8D26\u53F7\u5B89\u5168\u901A\u77E5\uFF0C\u4E0D\u4F1A\u516C\u5F00\u5C55\u793A\u3002<br>\u8BF7\u586B\u5199\u672C\u4EBA\u957F\u671F\u53EF\u7528\u90AE\u7BB1\uFF1B\u586B\u5199\u9519\u8BEF\u5C06\u65E0\u6CD5\u627E\u56DE\u5BC6\u7801\u3002<br><br>\u8F93\u5165\u65B0\u90AE\u7BB1</span>
                    <span class="ui en">
                        Your email is used for login, password recovery and account security, and is never displayed publicly.<br><br>
                        Enter a long-term email address
                    </span>
                    `,
        text: r.email,
        action(email, context) {
          context.setDisabled(true)
          XHR.put('user/update', { email })
            .then((r2) => {
              if (r2.code == 1) {
                context.close()
                FloatMsgs.show({
                  type: 'success',
                  persist: true,
                  msg:
                    /*html*/
                    `
                                <span class="ui zh">\u90AE\u7BB1\u4FEE\u6539\u6210\u529F\uFF0C\u8BF7\u786E\u8BA4\u65B0\u90AE\u7BB1\u957F\u671F\u53EF\u7528</span>
                                <span class="ui en">Email updated successfully</span>`,
                })
              }
              context.setDisabled(false)
            })
            .catch(() => {
              context.setDisabled(false)
            })
        },
      }),
    )
  },
  changePassword() {
    Popup.show('setPasswordPopup')
  },
  changeAvatar() {
    Popup.show('setAvatarPopup')
  },
  getMe() {
    return XHR.get('user/me', void 0, { silentStatuses: [401] })
  },
  showMe() {
    Popup.show('userHome')
  },
  convertAvatarPath(avatar) {
    return avatar
      ? `/api/data/images/avatars/` + encodeURIComponent(avatar)
      : `/res/defaultAvatar.png`
  },
  loadUserInfo() {
    var userInfo = document.getElementById('userInfo')
    var avatar = document.getElementById('userInfoAvatar')
    var name = document.getElementById('userInfoName')
    return User.getMe()
      .then((r) => {
        XHR.token = 'session'
        this.LoggedOnUserId = r.id
        this.loginState = 'authenticated'
        avatar.src = User.convertAvatarPath(r.avatar)
        name.textContent = r.name
        try {
          document.getElementById('msgPopupAvatar').src =
            User.convertAvatarPath(r.avatar)
          document.getElementById('senderText').textContent = r.name
        } catch (error) {
          void error
        }
        try {
          Popup.VuePopups.getAllPopups().forEach((v) => {
            if (v.$el.classList.contains('userHome')) {
              v.getUser()
            }
          })
        } catch (error) {
          logErr(error, 'Failed to access popup instances')
        }
        userInfo.onclick = () => this.showMe()
        userInfo.classList.remove('nologin')
        refreshCommentActions()
        return true
      })
      .catch(() => {
        XHR.token = ''
        XHR.csrfToken = ''
        this.LoggedOnUserId = null
        this.loginState = 'unauthenticated'
        avatar.src = User.convertAvatarPath('')
        name.innerHTML =
          '<span class="ui zh">\u8BBF\u5BA2</span><span class="ui en">Anonymous</span>'
        try {
          document.getElementById('msgPopupAvatar').src =
            User.convertAvatarPath('')
          document.getElementById('senderText').innerHTML =
            '<span class="ui zh">\u533F\u540D\u7528\u6237</span><span class="ui en">Anonymous</span>'
        } catch (error) {
          void error
        }
        userInfo.onclick = () => Popup.show('loginPopup')
        userInfo.classList.add('nologin')
        refreshCommentActions()
        return false
      })
  },
  logout() {
    XHR.post('user/logout').finally(() => {
      XHR.token = ''
      XHR.csrfToken = ''
      closePopup()
      setTimeout(loadUserInfo, 0)
    })
  },
  resetToken() {
    XHR.post('user/resettoken').finally(() => {
      XHR.token = ''
      XHR.csrfToken = ''
      closePopup()
      setTimeout(loadUserInfo, 0)
    })
  },
}
var loadUserInfo = User.loadUserInfo.bind(User)
try {
  if (!STATIC_SHOWCASE_MODE) User.init()
} catch (error) {
  logErr(error, 'failed to init user')
}
const Theme = {
  elements: {
    bgs: document.getElementsByClassName('mainbg'),
    captionContainer: document.getElementById('mainCaptions'),
    captions: document.getElementById('mainCaptions').children,
    themeIndicators: document.getElementById('currentTheme').children,
    listSelectors: document.querySelectorAll('#themeList>div[data-theme]'),
    lowerPanel: document.getElementById('lowerPanel'),
  },
  timers: {
    timeouts: [],
    intervals: [],
    setTimeout(f, timeout) {
      while (this.timeouts.length >= 100) this.timeouts.shift()
      this.timeouts.push(setTimeout(() => f(), timeout))
    },
    setInterval(f, timeout) {
      this.intervals.push(setInterval(() => f(), timeout))
    },
    clear() {
      this.timeouts.forEach((i) => {
        clearTimeout(i)
      })
      this.intervals.forEach((i) => {
        clearInterval(i)
      })
      this.timeouts = []
      this.intervals = []
    },
  },
  themes: {
    '#default-theme': 'default',
  },
  theme: '',
  currentBG: -1,
  currentCaption: -1,
  init() {
    this.prepareVisitOrder()
    this.setTheme(this.themes[location.hash])
    const layoutQuery = window.matchMedia('(max-width: 720px)')
    const relayout = () => {
      this.prepareVisitOrder()
      this.setTheme()
    }
    layoutQuery.addEventListener
      ? layoutQuery.addEventListener('change', relayout)
      : layoutQuery.addListener(relayout)
    setInterval(() => {
      let newAutoTheme = this.getAutoTheme()
      if (this.lastAutoTheme && this.lastAutoTheme != newAutoTheme)
        this.setTheme()
      this.lastAutoTheme = newAutoTheme
    }, 1e3)
    Array.from(this.elements.listSelectors).forEach((e) => {
      e.onclick = () => {
        this.setTheme(e.dataset.theme)
        closePopup()
      }
    })
  },
  prepareVisitOrder() {
    Array.from(document.querySelectorAll('.mainbg[data-layout]')).forEach(
      (background) => {
        background.classList.add('defaultbg')
      },
    )
    const useMobileBackgrounds = window.matchMedia('(max-width: 720px)').matches
    const activeLayout = useMobileBackgrounds ? 'portrait' : 'landscape'
    const allBackgrounds = Array.from(
      document.querySelectorAll('.mainbg.defaultbg'),
    )
    const backgrounds = allBackgrounds.filter(
      (background) => background.dataset.layout == activeLayout,
    )
    allBackgrounds
      .filter((background) => background.dataset.layout != activeLayout)
      .forEach((background) => background.classList.remove('defaultbg'))
    shuffleArray(backgrounds)
    backgrounds.forEach((background) => {
      background.dataset.activeSrc = background.dataset.src
      this.elements.captionContainer.before(background)
    })
    const firstBackground = backgrounds[0]?.dataset.activeSrc
    if (firstBackground) {
      const preload = document.createElement('link')
      preload.rel = 'preload'
      preload.as = 'image'
      preload.type = 'image/webp'
      preload.href = firstBackground
      preload.fetchPriority = 'high'
      document.head.appendChild(preload)
    }
    const blocks = []
    Array.from(document.getElementsByClassName('defaultCaption')).forEach(
      (caption) => {
        const group = caption.dataset.sequenceGroup || ''
        const lastBlock = blocks[blocks.length - 1]
        if (group && lastBlock?.group == group) {
          lastBlock.items.push(caption)
        } else {
          blocks.push({ group, items: [caption] })
        }
      },
    )
    shuffleArray(blocks)
    blocks
      .flatMap((block) => block.items)
      .forEach((caption) => {
        this.elements.captionContainer.appendChild(caption)
      })
  },
  getAutoTheme() {
    return 'default'
  },
  setTheme(theme) {
    if (!theme) theme = this.getAutoTheme()
    Array.from(this.elements.bgs).forEach((el) => {
      el.classList.remove('ready', 'animating', 'visible')
    })
    Array.from(this.elements.captions).forEach((el) => {
      el.classList.remove('visible')
    })
    Array.from(this.elements.themeIndicators).forEach((el) => {
      el.classList.remove('visible')
    })
    try {
      document.getElementById(`themeTxt-${theme}`).classList.add('visible')
    } catch (error) {
      logErr(error, 'theme indicator text not defined')
    }
    this.timers.clear()
    this.theme = theme
    this.currentBG = this.getCurrentBgCount() - 1
    this.currentCaption = -1
    this.getCurrentBgs()[0].classList.add('bgzoom')
    this.elements.captionContainer.style.opacity = 0
    setOneTimeCSS(this.elements.captionContainer, { transition: 'none' })
    this.nextImg()
    this.nextCaption()
    if (this.getCurrentBgCount() > 1) {
      this.timers.setInterval(() => this.nextImg(), 8e3)
      this.timers.setInterval(() => this.nextCaption(), 8e3)
    }
    this.elements.lowerPanel.classList.add('animating')
    this.timers.setTimeout(
      () => this.elements.lowerPanel.classList.remove('animating'),
      1700,
    )
    try {
      MusicPlayer.setActiveSong(this.getThemeMusic())
      if (!MusicPlayer.userPaused) MusicPlayer.play()
    } catch (error) {
      void error
    }
  },
  getThemeMusic() {
    return 'Elysian Realm'
  },
  getCurrentBgs() {
    return document.querySelectorAll(`.mainbg.${this.theme}bg`)
  },
  getCurrentBgCount() {
    return document.getElementsByClassName(`${this.theme}bg`).length
  },
  nextImg() {
    let prev = this.currentBG
    this.currentBG = prev + 1 < this.getCurrentBgCount() ? prev + 1 : 0
    let next =
      this.currentBG + 1 < this.getCurrentBgCount() ? this.currentBG + 1 : 0
    let bgs = document.getElementsByClassName(`${this.theme}bg`)
    try {
      bgs[prev].classList.remove('visible')
      bgs[this.currentBG].classList.add('ready', 'animating', 'visible')
      const currentSource =
        bgs[this.currentBG].dataset.activeSrc || bgs[this.currentBG].dataset.src
      bgs[this.currentBG].firstElementChild.style.backgroundImage =
        `url("${currentSource}")`
      if (prev == this.currentBG) return
      this.timers.setTimeout(() => {
        bgs[prev].classList.remove('ready', 'animating')
        bgs[next].classList.add('ready')
        bgs[next].classList.remove('bgzoom')
        const nextSource = bgs[next].dataset.activeSrc || bgs[next].dataset.src
        bgs[next].firstElementChild.style.backgroundImage =
          `url("${nextSource}")`
      }, 2500)
    } catch (error) {
      logErr(error, 'failed to show next image')
    }
  },
  nextCaption() {
    try {
      var themeCaptions = document.getElementsByClassName(
        `${this.theme}Caption`,
      )
    } catch (error) {
      logErr(error, 'failed to select caption')
      return
    }
    if (themeCaptions.length == 1) {
      this.timers.setTimeout(() => {
        themeCaptions[0].classList.add('visible')
        this.elements.captionContainer.style.opacity = 1
      }, 500)
      return
    }
    this.elements.captionContainer.style.opacity = 0
    this.timers.setTimeout(() => {
      for (var i = 0; i < themeCaptions.length; i++) {
        themeCaptions[i].classList.remove('visible')
      }
      if (this.currentCaption < themeCaptions.length - 1) {
        this.currentCaption++
      } else {
        this.currentCaption = 0
      }
      themeCaptions[this.currentCaption].classList.add('visible')
      this.elements.captionContainer.style.opacity = 1
    }, 1500)
  },
}
try {
  Theme.init()
} catch (error) {
  logErr(error, 'failed to init theme')
}
function getFullscreenHorizonalCommentCount() {
  if (!isFullscreen) return null
  var latestCommentEl = document.getElementById(
    'loadingIndicatorBefore',
  ).nextElementSibling
  var top = latestCommentEl.getBoundingClientRect().top
  latestCommentEl = latestCommentEl.nextElementSibling
  var count = 1
  while (top == latestCommentEl.getBoundingClientRect().top) {
    count++
    latestCommentEl = latestCommentEl.nextElementSibling
  }
  return count
}
function loadTimeline(timeStamp) {
  var timelineEl = document.getElementById('timeline')
  timelineEl.innerHTML = ''
  var date = new Date(Math.max(timeStamp * 1e3, TIMELINE_START_MS))
  date.setDate(1)
  date.setHours(0, 0, 0, 0)
  while (date.getTime() >= TIMELINE_START_MS) {
    var yearEl = document.createElement('p')
    const year = date.getFullYear()
    yearEl.appendChild(html2elmnt(`<strong>${year}</strong>`))
    while (date.getFullYear() === year && date.getTime() >= TIMELINE_START_MS) {
      yearEl.appendChild(html2elmnt(`<span>${date.getMonth() + 1}</span>`))
      date.setMonth(date.getMonth() - 1)
    }
    timelineEl.appendChild(yearEl)
  }
}
function getCurrentComment() {
  var scrolled = 0
  if (!isFullscreen) {
    scrolled = commentDiv.scrollLeft / commentDiv.scrollWidth
  } else {
    scrolled = commentDiv.scrollTop / commentDiv.scrollHeight
  }
  var commentList = document.getElementsByClassName('commentItem')
  return commentList[Math.round(commentList.length * scrolled)]
}
function setTimelineActiveMonth(scroll = false) {
  try {
    var timeStamp = parseInt(getCurrentComment().dataset.timestamp) * 1e3
    var date = new Date(timeStamp)
    var year = date.getFullYear()
    var month = date.getMonth() + 1
    const yearEls = document.getElementById('timeline').children
    for (let i = 0; i < yearEls.length; i++) {
      const yearEl = yearEls[i]
      if (yearEl.firstElementChild.innerHTML == year) {
        yearEl.firstElementChild.classList.add('month-active')
        if (scroll)
          yearEl.scrollIntoView({
            behavior: 'smooth',
            block: 'center',
            inline: 'center',
          })
      } else {
        yearEl.firstElementChild.classList.remove('month-active')
      }
      for (let i2 = 0; i2 < yearEl.children.length; i2++) {
        const monthEl = yearEl.children[i2]
        if (monthEl.nodeName == 'SPAN') {
          if (
            yearEl.firstElementChild.innerHTML == year &&
            monthEl.innerHTML == month
          ) {
            monthEl.classList.add('month-active')
          } else {
            monthEl.classList.remove('month-active')
          }
        }
      }
    }
    setHoverCalendarActiveDay()
  } catch (error) {
    logErr(error, 'failed to update active timeline month')
  }
}
function setHoverCalendarActiveDay() {
  try {
    var timeStamp = parseInt(getCurrentComment().dataset.timestamp) * 1e3
    var date = new Date(timeStamp)
    const dayEls = hoverCalendarEl.querySelectorAll('div[data-time]')
    for (let i = 0; i < dayEls.length; i++) {
      const dayEl = dayEls[i]
      var date1 = new Date(dayEl.dataset.time)
      if (
        date.getFullYear() == date1.getFullYear() &&
        date.getMonth() == date1.getMonth() &&
        date.getDate() == date1.getDate()
      ) {
        dayEl.classList.add('day-active')
      } else {
        dayEl.classList.remove('day-active')
      }
    }
  } catch (error) {
    logErr(error, 'failed to update active timeline day')
  }
}
function setTodayCommentCount() {
  XHR.get('comments/count')
    .then((count) => {
      const value = Number(count)
      document.getElementById('todayCommentCount').textContent =
        Number.isFinite(value) ? String(value) : '0'
    })
    .catch(() => {
      document.getElementById('todayCommentCount').textContent = '0'
    })
}
function toggleFullscreen() {
  if (!isFullscreen) {
    var scrollPercent =
      commentDiv.scrollLeft / (commentDiv.scrollWidth - commentDiv.clientWidth)
    setTimeout(() => {
      commentDiv.scrollTop =
        (commentDiv.scrollHeight - commentDiv.clientHeight) * scrollPercent
      setTimelineActiveMonth(true)
    }, 35)
    document.body.classList.add('fullscreen')
    document.getElementById('fullscreenBtn').innerHTML =
      '<span class="ui zh">\u9000\u51FA\u5168\u5C4F \u2199</span><span class="ui en">Collapse \u2199</span>'
    isFullscreen = true
  } else {
    var scrollPercent =
      commentDiv.scrollTop / (commentDiv.scrollHeight - commentDiv.clientHeight)
    setTimeout(() => {
      commentDiv.scrollLeft =
        (commentDiv.scrollWidth - commentDiv.clientWidth) * scrollPercent
      setTimelineActiveMonth(true)
    }, 35)
    document.body.classList.remove('fullscreen')
    document.getElementById('fullscreenBtn').innerHTML =
      '<span class="ui zh">\u7AD6\u5C4F \u2195</span><span class="ui en">Expand \u2195</span>'
    isFullscreen = false
  }
  Comments.pauseScroll(500)
}
function toggleTopComment() {
  setConfig('hideTopComment', hideTopCommentElmnt.checked)
  if (hideTopCommentElmnt.checked) {
    document.getElementById('topComment').style.display = 'none'
    topComment = document.getElementById('topComment').outerHTML
  } else {
    document.getElementById('topComment').style.removeProperty('display')
    topComment = document.getElementById('topComment').outerHTML
  }
}
function toggleTimeline() {
  setConfig('showTimeline', showTimelineElmnt.checked)
  if (showTimelineElmnt.checked) {
    document.getElementById('timelineContainer').style.display = 'block'
    commentDiv.classList.add('noscrollbar')
  } else {
    document.getElementById('timelineContainer').style.display = 'none'
    commentDiv.classList.remove('noscrollbar')
  }
}
function getRandomIntInclusive(min, max) {
  min = Math.ceil(min)
  max = Math.floor(max)
  return Math.floor(Math.random() * (max - min + 1) + min)
}
function html2elmnt(html) {
  html = html.trim()
  var t = document.createElement('template')
  t.innerHTML = html
  return t.content
}
function htmlEscape(txt) {
  return txt
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\r\n/g, '<br>')
    .replace(/\n/g, '<br>')
}
function compareArr(a1, a2) {
  for (let i = 0; i < a1.length; i++) {
    if (a1[i] != a2[i]) {
      return a1[i] - a2[i]
    } else {
      continue
    }
  }
  return 0
}
function obj2queryString(obj) {
  return toQueryString(obj)
}
function getFileListAsync(url) {
  return new Promise((resolve, reject) => {
    fetch(url)
      .then((res) => Promise.all([res.url, res.text()]))
      .then(([url2, text]) => {
        const doc = document.createElement('template')
        doc.innerHTML = text
        const filelist = []
        const alist = doc.content.querySelectorAll('a')
        for (let i = 0; i < alist.length; i++) {
          let a = alist[i]
          if (
            a.previousSibling &&
            !a.previousSibling.textContent.includes('<dir>')
          ) {
            filelist.push(url2 + encodeURIComponent(a.textContent))
          }
        }
        resolve(filelist)
      })
  })
}
function getFileNameWithoutExt(path, decodeuri = false) {
  if (decodeuri) {
    return decodeURIComponent(path.match(/[^\\/]+(?=\.\w+$)/)[0])
  } else {
    return path.match(/[^\\/]+(?=\.\w+$)/)[0]
  }
}
function shuffleArray(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[array[i], array[j]] = [array[j], array[i]]
  }
}
function getArrayNextItem(arr, item) {
  let x = arr[arr.indexOf(item) + 1]
  return x != null ? x : arr[0]
}
function getArrayPrevItem(arr, item) {
  let x = arr[arr.indexOf(item) - 1]
  return x != null ? x : arr[arr.length - 1]
}
function logErr(err, msg) {
  console.warn(err)
  console.error(msg)
}
function setOneTimeCSS(el, styles) {
  for (let style in styles) {
    el.style[style] = styles[style]
  }
  setTimeout(() => {
    for (let style in styles) {
      el.style.removeProperty(style)
    }
  }, 35)
}
function readFile(blob) {
  return new Promise((resolve, reject) => {
    let reader = new FileReader()
    reader.readAsDataURL(blob)
    reader.onload = () => {
      resolve(reader.result)
    }
  })
}
function resizeImg(img, aspectRatio, maxPixels) {
  return new Promise((resolve, reject) => {
    if (typeof img != 'string') {
      if (img && img.type.match(/image.*/)) {
        readFile(img).then((i) => {
          resizeImg(i, aspectRatio, maxPixels).then((i2) => resolve(i2))
        })
      } else {
        FloatMsgs.show({
          type: 'error',
          msg: '<span class="ui zh">\u56FE\u7247\u65E0\u6548</span><span class="ui en">Invalid image</span>',
        })
      }
      return
    }
    let image = new Image()
    image.src = img
    image.onload = () => {
      let width = image.width
      let height = image.height
      if (aspectRatio) {
        if (width / height > aspectRatio) {
          width = height * aspectRatio
        } else {
          height = width / aspectRatio
        }
      }
      if (maxPixels && width * height > maxPixels) {
        let zoom = Math.sqrt(maxPixels / (width * height))
        width *= zoom
        height *= zoom
      }
      width = Math.round(width)
      height = Math.round(height)
      var canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      var ctx = canvas.getContext('2d')
      if (aspectRatio) {
        if (image.width / image.height > aspectRatio) {
          ctx.drawImage(
            image,
            (image.width - image.height * aspectRatio) / 2,
            0,
            image.height * aspectRatio,
            image.height,
            0,
            0,
            width,
            height,
          )
        } else {
          ctx.drawImage(
            image,
            0,
            (image.height - image.width / aspectRatio) / 2,
            image.width,
            image.width / aspectRatio,
            0,
            0,
            width,
            height,
          )
        }
      } else {
        ctx.drawImage(image, 0, 0, width, height)
      }
      resolve(canvas.toDataURL('image/jpeg'))
    }
  })
}
function isEmail(s) {
  return /^\S+@\S+\.\S+$/.test(s)
}
var maxTimelineTime = 0
const bgContainer = document.getElementById('bgContainer')
const lowerPanel = document.getElementById('lowerPanel')
var commentDiv = document.getElementById('comments')
var hoverCalendarEl = document.getElementById('hoverCalendar')
var hideTopCommentElmnt = document.getElementById('hideTopComment')
var showTimelineElmnt = document.getElementById('showTimeline')
var topComment = document.getElementById('topComment').outerHTML
var loadingIndicator = document.getElementById('loadingIndicator').outerHTML
var loadingIndicatorBefore = document.getElementById(
  'loadingIndicatorBefore',
).outerHTML
document.getElementById('loadingIndicatorBefore').style.display = 'none'
var isFullscreen = false
document.querySelector('#mainTitle>a').href =
  location.origin + location.pathname
var debug = false
if (!STATIC_SHOWCASE_MODE && location.hash == '#debug') {
  debug = true
  setTimeout(() => {
    Comments.forceLowerPanelUp()
  }, 0)
}
if (location.hash.slice(0, 7) == '#popup-') {
  try {
    showPopup(location.hash.slice(7))
  } catch (error) {
    closePopup()
    location.hash = ''
  }
}
if (getConfig('hideTopComment') == 'true') {
  hideTopCommentElmnt.checked = true
  document.getElementById('topComment').style.display = 'none'
  topComment = document.getElementById('topComment').outerHTML
}
if (getConfig('showTimeline') == 'false') {
  showTimelineElmnt.checked = false
  toggleTimeline()
}
function playBG() {}
playBG()
const Comments = {
  elements: {
    container: document.getElementById('comments'),
    seekArrows: document.getElementsByClassName('commentSeekArrow'),
  },
  seekLeft: 0,
  seekDone: true,
  scrollPaused: false,
  swipeController: void 0,
  lastTimeUpToDate: null,
  get upToDate() {
    return this.lastTimeUpToDate != null
      ? /* @__PURE__ */ new Date().getTime() - this.lastTimeUpToDate < 1e4
      : false
  },
  set upToDate(value) {
    if (value) {
      this.lastTimeUpToDate = /* @__PURE__ */ new Date()
    } else {
      this.lastTimeUpToDate = null
    }
  },
  hasItem() {
    return Boolean(document.querySelector('.commentItem'))
  },
  seek(delta) {
    if (!this.hasItem()) return
    const commentWidth = this.getCommentWidth()
    if (this.seekDone) {
      this.seekLeft =
        (Math.round(this.elements.container.scrollLeft / commentWidth) +
          delta) *
        commentWidth
      window.requestAnimationFrame((t1) =>
        this.seekAnimate(t1, this.elements.container.scrollWidth),
      )
    } else {
      this.seekLeft += delta * commentWidth
    }
    if (this.seekLeft < 0) this.seekLeft = 0
    if (
      this.seekLeft >
      this.elements.container.scrollWidth - this.elements.container.clientWidth
    )
      this.seekLeft =
        this.elements.container.scrollWidth -
        this.elements.container.clientWidth
  },
  seekAnimate(t, scrollWidth) {
    if (this.seekDone == true) {
      this.seekDone = false
      this.t0 = t
      window.requestAnimationFrame((t1) => this.seekAnimate(t1, scrollWidth))
      return
    }
    let fps = 1e3 / (t - this.t0)
    this.t0 = t
    const distance_delta = this.seekLeft - this.elements.container.scrollLeft
    let prevScrollLeft = this.elements.container.scrollLeft
    if (
      Math.abs(distance_delta) > 1 &&
      this.elements.container.scrollWidth == scrollWidth
    ) {
      this.elements.container.scrollLeft += distance_delta / ((5 * fps) / 60)
    }
    if (prevScrollLeft == this.elements.container.scrollLeft) {
      this.seekDone = true
    } else {
      window.requestAnimationFrame((t1) => this.seekAnimate(t1, scrollWidth))
    }
  },
  scroll() {
    if (this.scrollPaused || !this.hasItem()) return
    setTimelineActiveMonth()
    if (!isFullscreen) {
      var toStart = commentDiv.scrollLeft
      var toEnd =
        commentDiv.scrollWidth - commentDiv.clientWidth - commentDiv.scrollLeft
      var threshold = getFirstVisibleComment().offsetWidth / 8
    } else {
      var toStart = commentDiv.scrollTop
      var toEnd =
        commentDiv.scrollHeight - commentDiv.clientHeight - commentDiv.scrollTop
      var threshold = getFirstVisibleComment().offsetHeight / 8
    }
    if (toStart <= threshold && Comments.upToDate == false) {
      loadNewerComments()
      this.pauseScroll(500)
      this.swipeController.stopOngoingScroll()
    }
    if (toEnd <= threshold) {
      loadOlderComments()
      this.pauseScroll(500)
      this.swipeController.stopOngoingScroll()
    }
    if (!isFullscreen) {
      toStart < threshold
        ? (this.elements.seekArrows[0].style.display = 'none')
        : this.elements.seekArrows[0].style.removeProperty('display')
    }
  },
  pauseScroll(time) {
    this.scrollPaused = true
    setTimeout(() => {
      this.scrollPaused = false
    }, time)
  },
  getCommentWidth() {
    return (
      getFirstVisibleComment().getBoundingClientRect().width +
      20 * Settings.pageScale
    )
  },
  GetTargetCommentScrollability(target) {
    while (this.elements.container.contains(target)) {
      if (target.classList.contains('comment') || target.id == 'msgText') {
        return {
          inputable: target.id == 'msgText',
          scrollable: target.scrollHeight > target.clientHeight,
          top: target.scrollTop < 1,
          bottom:
            target.scrollHeight - target.clientHeight - target.scrollTop < 1,
        }
      }
      target = target.parentNode
    }
    return {
      inputable: false,
      scrollable: false,
      top: true,
      bottom: true,
    }
  },
  forceLowerPanelUp() {
    lowerPanel.classList.add('lowerPanelUp')
    lowerPanel.classList.remove('lowerPanelDown')
    document.documentElement.style.overscrollBehavior = 'contain'
    document.body.style.overscrollBehavior = 'contain'
  },
  forceLowerPanelDown() {
    lowerPanel.classList.remove('lowerPanelUp')
    lowerPanel.classList.add('lowerPanelDown')
    setTimeout(() => {
      document.documentElement.style.removeProperty('overscroll-behavior')
      document.body.style.removeProperty('overscroll-behavior')
    }, 300)
    try {
      document.getElementById('msgText').blur()
    } catch (error) {
      void error
    }
  },
  init() {
    setTodayCommentCount()
    loadComments()
    addPullDownRefresh(
      this.elements.container,
      loadNewerComments,
      () =>
        isFullscreen &&
        document.getElementById('loadingIndicatorBefore')?.style.display ==
          'none' &&
        document.getElementById('newCommentBox') == null,
    )
    this.swipeController = new GallerySwipeController(this.elements.container, {
      maxItemDelta: 1,
      getStopPosition: (itemDelta) => {
        const commentWidth = this.getCommentWidth()
        return (
          (Math.round(this.elements.container.scrollLeft / commentWidth) +
            itemDelta) *
          commentWidth
        )
      },
      getItemSize: () => {
        return this.getCommentWidth()
      },
    })
    this.elements.container.onwheel = (e) => {
      if (isFullscreen) return
      if (
        (e.deltaX < 0 && this.elements.container.scrollLeft == 0) ||
        (e.deltaX > 0 &&
          this.elements.container.scrollWidth -
            this.elements.container.clientWidth -
            this.elements.container.scrollLeft <
            1)
      ) {
        e.preventDefault()
        return
      }
      if (
        e.deltaX || // horizontal trackpad scroll / mouse wheel tilt
        (e.deltaMode == WheelEvent.DOM_DELTA_PIXEL && Math.abs(e.deltaY) < 10)
      )
        return
      if (e.shiftKey) e.preventDefault()
      let scroll = this.GetTargetCommentScrollability(e.target)
      if (!scroll.inputable && !scroll.scrollable) {
        this.seek(e.deltaY > 0 ? 1 : -1)
      }
    }
    this.elements.container.onscroll = () => this.scroll()
    setInterval(() => this.scroll(), 1e3)
    bgContainer.addEventListener('click', this.forceLowerPanelDown)
    bgContainer.addEventListener('touchstart', this.forceLowerPanelDown)
    document.addEventListener('mouseover', () =>
      lowerPanel.classList.remove('lowerPanelDown'),
    )
    lowerPanel.addEventListener('touchstart', function (e) {
      this.lastTouchStart = e.touches[0]
      this.lastTouchMove = null
      this.timeTouchStart = e.timeStamp
      Comments.forceLowerPanelUp()
      document.getElementById('mouseScrollTooltip').style.display = 'none'
    })
    lowerPanel.addEventListener('touchmove', function (e) {
      const currentTouch = e.touches[0]
      const deltaX = currentTouch.clientX - this.lastTouchStart.clientX
      const deltaY = currentTouch.clientY - this.lastTouchStart.clientY
      if (!this.lastTouchMove && deltaY > Math.abs(deltaX) && !isFullscreen) {
        let scroll = Comments.GetTargetCommentScrollability(e.target)
        this.touchMoveLowerPanel = scroll.inputable
          ? !scroll.scrollable
          : scroll.top
      }
      if (this.touchMoveLowerPanel && deltaY > 0 && !isFullscreen) {
        lowerPanel.style.transform = `translateY(${deltaY}px)`
        lowerPanel.style.transition = 'none'
      }
      this.lastTouchMove = currentTouch
      this.timeLastMove = e.timeStamp
    })
    lowerPanel.addEventListener('touchend', function (e) {
      if (this.touchMoveLowerPanel) {
        lowerPanel.style.removeProperty('transform')
        lowerPanel.style.removeProperty('transition')
      }
      try {
        const deltaY = this.lastTouchMove.clientY - this.lastTouchStart.clientY
        const deltaTime = this.timeLastMove - this.timeTouchStart
        if (
          this.touchMoveLowerPanel &&
          (deltaY / window.innerHeight > 0.15 ||
            deltaY / window.innerHeight / deltaTime > 7e-4)
        ) {
          Comments.forceLowerPanelDown()
        }
      } catch (error) {
        void error
      }
      this.touchMoveLowerPanel = false
    })
  },
}
var seekComment = Comments.seek.bind(Comments)
try {
  if (!STATIC_SHOWCASE_MODE) Comments.init()
} catch (error) {
  logErr(error, 'failed to init comments')
}
const msgBgInfo = Array.from(
  document.querySelectorAll('.mainbg[data-layout="portrait"][data-src]'),
).map((background) => ({
  src: background.dataset.src,
}))
const msgBgCount = msgBgInfo.length
var lastBgImgs = []
document
  .getElementById('timelineContainer')
  .addEventListener('click', (event) => {
    if (event.target.nodeName == 'STRONG') {
      var year = parseInt(event.target.innerHTML)
      if (
        event.target ==
        document.getElementById('timeline').firstElementChild.firstElementChild
      ) {
        clearComments()
        loadComments()
        return
      }
      var date = new Date(year + 1, 0, 0)
    } else if (event.target.nodeName == 'SPAN') {
      if (event.target.classList[0] == 'month-active') return
      var year = parseInt(event.target.parentNode.firstElementChild.innerHTML)
      var month = parseInt(event.target.innerHTML)
      var date = new Date(year, month, 0, 23, 59, 59, 999)
    } else if (event.target.hasAttribute('data-time')) {
      var date = new Date(event.target.dataset.time)
      date.setHours(23, 59, 59, 999)
    } else return
    var timestamp = Math.min(date.getTime(), maxTimelineTime * 1e3) / 1e3
    clearComments(1)
    loadComments({ time: timestamp })
  })
document
  .getElementById('timelineContainer')
  .addEventListener('wheel', (event) => {
    if (!isFullscreen)
      document.getElementById('timeline').scrollLeft += event.deltaY / 2
  })
document
  .getElementById('timelineContainer')
  .addEventListener('mouseover', (event) => {
    if (event.target.nodeName == 'SPAN') {
      if (!isFullscreen) {
        var left =
          event.target.getBoundingClientRect().left +
          event.target.getBoundingClientRect().width / 2
        var width = 113
        if (left + width > window.innerWidth) left = window.innerWidth - width
        if (left < width) left = width
        hoverCalendarEl.style.left = left + 'px'
        hoverCalendarEl.style.bottom =
          document.getElementById('timelineContainer').getBoundingClientRect()
            .height + 'px'
        hoverCalendarEl.style.removeProperty('top')
        hoverCalendarEl.style.removeProperty('right')
      } else {
        hoverCalendarEl.style.top =
          event.target.getBoundingClientRect().top +
          event.target.getBoundingClientRect().height / 2 +
          'px'
        hoverCalendarEl.style.right =
          document.getElementById('timelineContainer').getBoundingClientRect()
            .width + 'px'
        hoverCalendarEl.style.removeProperty('left')
        hoverCalendarEl.style.removeProperty('bottom')
      }
      hoverCalendarEl.style.removeProperty('display')
      hoverCalendarEl.innerHTML = ''
      var year = parseInt(event.target.parentNode.firstElementChild.innerHTML)
      var month = parseInt(event.target.innerHTML)
      hoverCalendarEl.appendChild(
        html2elmnt(`<div>${year}-${('0' + month).slice(-2)}</div>`),
      )
      for (let i = 1; i <= new Date(year, month, 0).getDate(); i++) {
        const day = new Date(year, month - 1, i)
        if (
          day.getTime() >= TIMELINE_START_MS &&
          day.getTime() / 1e3 < maxTimelineTime
        )
          hoverCalendarEl.appendChild(
            html2elmnt(`<div data-time="${day.toDateString()}">${i}</div>`),
          )
      }
      setHoverCalendarActiveDay()
    } else if (event.target.nodeName == 'STRONG') {
      hoverCalendarEl.style.display = 'none'
    }
  })
document.getElementById('goto').addEventListener('keypress', function (event) {
  if (event.key === 'Enter') {
    event.preventDefault()
    clearComments(1)
    loadComments({ number: document.getElementById('goto').value })
  }
})
var viewImg = ImgViewer.view.bind(ImgViewer)
var closeImgViewer = ImgViewer.close.bind(ImgViewer)
const MusicPlayer = {
  elements: {
    player: document.getElementById('musicAudio'),
    playerImg: document.getElementById('musicImg'),
    playBtn: document.getElementById('musicPlayBtn'),
    playingIndicators: document.getElementsByClassName('musicPlayingIndicator'),
    titles: document.getElementsByClassName('currentSong'),
    progressSlider: void 0,
    list: document.getElementById('songList'),
    shuffleBtn: document.getElementById('musicShuffleBtn'),
  },
  playList: [],
  playOrder: [],
  userPaused: true,
  prefetchScheduled: false,
  playbackStateKey: 'musicPlaybackStateV1',
  lastPersistedSecond: -1,
  loadPlayList(dir) {
    this.elements.list.innerHTML = ''
    const upcoming = OFFICIAL_MUSIC.filter((name) => name != DEFAULT_MUSIC)
    shuffleArray(upcoming)
    this.playList = [DEFAULT_MUSIC, ...upcoming].map(
      (name) => `${dir}${encodeURIComponent(name)}`,
    )
    this.playOrder = []
    this.showPlayList(this.playList)
    this.setActiveSong(Theme.getThemeMusic())
  },
  showPlayList(list) {
    for (let url of list) {
      this.elements.list.appendChild(
        html2elmnt(`
                <li>${getFileNameWithoutExt(url, true)}</li>
            `),
      )
    }
  },
  setActiveSong(index) {
    if (typeof index != 'number') {
      for (let i = 0; i < this.playList.length; i++) {
        if (decodeURIComponent(this.playList[i]).includes(index)) {
          index = i
          break
        }
      }
    }
    if (this.playList[index] == null) return
    this.elements.player.src = this.playList[index]
    this.elements.player.load()
    this.elements.playerImg.onclick = null
    this.elements.playerImg.src = '/res/music_note.svg'
    for (let i = 0; i < this.elements.titles.length; i++) {
      this.elements.titles[i].textContent = getFileNameWithoutExt(
        this.playList[index],
        true,
      )
    }
    for (let i = 0; i < this.elements.list.children.length; i++) {
      this.elements.list.children[i].classList.remove('playing')
    }
    this.elements.list.children[index].classList.add('playing')
    if (navigator.mediaSession) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: getFileNameWithoutExt(this.playList[index], true),
        artist: 'elytrue.com',
      })
    }
  },
  persistPlaybackState(force = false) {
    const index = this.getPlayingIndex()
    const url = this.playList[index]
    if (!url || !this.elements.player.src) return
    const currentTime = Number.isFinite(this.elements.player.currentTime)
      ? this.elements.player.currentTime
      : 0
    const currentSecond = Math.floor(currentTime)
    if (!force && Math.abs(currentSecond - this.lastPersistedSecond) < 2) return
    this.lastPersistedSecond = currentSecond
    setConfig(
      this.playbackStateKey,
      JSON.stringify({
        song: decodeURIComponent(url.slice(url.lastIndexOf('/') + 1)),
        currentTime,
        paused: this.userPaused,
      }),
    )
  },
  restorePlaybackState() {
    let state
    try {
      state = JSON.parse(getConfig(this.playbackStateKey))
    } catch (error) {
      return false
    }
    if (!state?.song || !Number.isFinite(state.currentTime)) return false
    const index = this.playList.findIndex(
      (url) =>
        decodeURIComponent(url.slice(url.lastIndexOf('/') + 1)) == state.song,
    )
    if (index < 0) return false
    this.setActiveSong(index)
    this.userPaused = state.paused !== false
    setConfig('mutebgm', this.userPaused)
    const restore = () => {
      const duration = this.elements.player.duration
      const upperBound =
        Number.isFinite(duration) && duration > 0
          ? Math.max(0, duration - 0.25)
          : state.currentTime
      this.elements.player.currentTime = Math.max(
        0,
        Math.min(state.currentTime, upperBound),
      )
      this.lastPersistedSecond = Math.floor(this.elements.player.currentTime)
      if (!this.userPaused) this.play()
    }
    if (this.elements.player.readyState >= 1) {
      restore()
    } else {
      this.elements.player.addEventListener('loadedmetadata', restore, {
        once: true,
      })
    }
    return true
  },
  scheduleUpcomingPrefetch() {
    if (this.prefetchScheduled) return
    this.prefetchScheduled = true
    const connection =
      navigator.connection ||
      navigator.mozConnection ||
      navigator.webkitConnection
    if (connection?.saveData) return
    const prefetch = () => {
      const current =
        this.elements.player.currentSrc || this.elements.player.src
      this.playList
        .filter((url) => new URL(url, location.href).href != current)
        .forEach((url) => {
          const link = document.createElement('link')
          link.rel = 'prefetch'
          link.as = 'audio'
          link.href = url
          link.fetchPriority = 'low'
          link.dataset.elytruePrefetch = 'music'
          document.head.appendChild(link)
        })
    }
    const schedule = () => {
      if ('requestIdleCallback' in window) {
        window.requestIdleCallback(prefetch, { timeout: 8e3 })
      } else {
        setTimeout(prefetch, 2500)
      }
    }
    if (document.readyState == 'complete') {
      setTimeout(schedule, 1200)
    } else {
      window.addEventListener('load', () => setTimeout(schedule, 1200), {
        once: true,
      })
    }
  },
  getPlayingIndex() {
    for (let i = 0; i < this.elements.list.children.length; i++) {
      if (this.elements.list.children[i].classList.contains('playing')) {
        return i
      }
    }
    return 0
  },
  checkPlayOrder() {
    if (this.playOrder.length != this.playList.length) {
      this.playOrder = [...Array(this.playList.length).keys()]
      if (this.elements.shuffleBtn.checked) {
        shuffleArray(this.playOrder)
      }
    }
  },
  play(index = null) {
    if (index == null && !this.elements.player.src) index = 0
    this.setActiveSong(index)
    const playAttempt = this.elements.player.play()
    if (playAttempt) playAttempt.catch(() => {})
    this.userPaused = false
    setConfig('mutebgm', false)
    this.persistPlaybackState(true)
  },
  playNext() {
    this.checkPlayOrder()
    this.play(getArrayNextItem(this.playOrder, this.getPlayingIndex()))
  },
  playPrev() {
    this.checkPlayOrder()
    this.play(getArrayPrevItem(this.playOrder, this.getPlayingIndex()))
  },
  pause() {
    this.userPaused = true
    setConfig('mutebgm', true)
    this.elements.player.pause()
    this.persistPlaybackState(true)
  },
  setVolume(vol) {
    this.elements.player.volume = vol
  },
  initPlayer(dir) {
    this.loadPlayList(dir)
    this.scheduleUpcomingPrefetch()
    if (this.restorePlaybackState()) {
    } else if (getConfig('mutebgm') == 'true') {
      this.userPaused = true
    } else {
      this.play()
    }
    this.elements.playBtn.onclick = () => {
      if (this.elements.player.paused) {
        this.play()
      } else {
        this.pause()
      }
    }
    this.elements.list.onclick = (e) => {
      if (Array.from(this.elements.list.children).includes(e.target)) {
        this.play(Array.from(this.elements.list.children).indexOf(e.target))
      }
    }
    this.elements.shuffleBtn.onchange = () => {
      this.playOrder = []
    }
    this.elements.list.parentNode.parentNode.querySelector(
      'button',
    ).onmouseenter = () => {
      this.elements.list
        .querySelector('.playing')
        .scrollIntoView({ block: 'center' })
    }
    this.elements.progressSlider = createApp(ProgressSlider, {
      onChange: (progress) => {
        this.elements.player.currentTime =
          this.elements.player.duration * progress
      },
    }).mount('#nowPlayingProgress')
    setInterval(() => {
      this.elements.progressSlider.progress =
        this.elements.player.currentTime / this.elements.player.duration
    }, 500)
    this.elements.player.onplay = () => {
      for (let i = 0; i < this.elements.playingIndicators.length; i++) {
        this.elements.playingIndicators[i].classList.add('playing')
      }
      this.persistPlaybackState(true)
    }
    this.elements.player.onpause = () => {
      for (let i = 0; i < this.elements.playingIndicators.length; i++) {
        this.elements.playingIndicators[i].classList.remove('playing')
      }
      this.persistPlaybackState(true)
    }
    this.elements.player.ontimeupdate = () => this.persistPlaybackState()
    this.elements.player.onended = () => {
      this.playNext()
    }
    window.addEventListener('pagehide', () => this.persistPlaybackState(true))
    document.addEventListener('click', () => {
      if (!this.userPaused && this.elements.player.paused) this.play()
    })
    if (navigator.mediaSession) {
      navigator.mediaSession.setActionHandler('play', () => this.play())
      navigator.mediaSession.setActionHandler('pause', () => this.pause())
      navigator.mediaSession.setActionHandler('previoustrack', () =>
        this.playPrev(),
      )
      navigator.mediaSession.setActionHandler('nexttrack', () =>
        this.playNext(),
      )
    }
  },
}
try {
  MusicPlayer.initPlayer(MUSIC_ROOT)
} catch (error) {
  logErr(error, 'failed to init music player')
}
var lastClickEvent
document.addEventListener('click', (e) => (lastClickEvent = e))
document.onkeydown = function (e) {
  if (e.key == 'Escape' || e.keyCode == 27) {
    if (ImgViewer.isOpen()) {
      closeImgViewer()
    } else if (Popup.isOpen()) {
      closePopup()
    } else if (isFullscreen) {
      toggleFullscreen()
    } else {
      Comments.forceLowerPanelDown()
    }
  }
}
if (window.location.hash == '#view-img' || window.location.hash == '#popup') {
  window.location.hash = ''
}
if (!STATIC_SHOWCASE_MODE && location.hash.startsWith('#resetpassword=')) {
  let passwordResetToken = location.hash.replace('#resetpassword=', '')
  Popup.show('setPasswordPopup', { passwordResetToken })
}
window.onhashchange = function (e) {
  if (e.oldURL.split('#')[1] == 'view-img') {
    closeImgViewer()
  }
  if (
    e.oldURL.split('#')[1] == 'popup' &&
    e.newURL.split('#')[1] != 'view-img'
  ) {
    closePopup()
  }
}
const TouchKeyboardDetector = {
  init() {
    window.addEventListener('resize', this.detect)
  },
  detect() {
    let input = document.getElementById('msgText')
    if (input && document.activeElement == input) {
      if (
        !document.body.classList.contains('touchKeyboardShowing') &&
        document.getElementById('newCommentBox').offsetHeight <
          370 * Settings.pageScale
      ) {
        document.body.classList.add('touchKeyboardShowing')
      }
    } else {
      document.body.classList.remove('touchKeyboardShowing')
    }
  },
}
try {
  TouchKeyboardDetector.init()
} catch (error) {
  logErr(error, 'failed to init TouchKeyboardDetector')
}
var installPrompt = null
window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault()
  installPrompt = event
})
var isInStandaloneMode = false
isInStandaloneMode =
  window.matchMedia('(display-mode: standalone)').matches ||
  window.navigator.standalone ||
  document.referrer.includes('android-app://')
window.wallpaperPropertyListener = {
  applyUserProperties(properties) {
    if (properties.ui_scale) {
      Settings.pageScale = properties.ui_scale.value / 100
    }
    if (properties.ui_bottom) {
      document.getElementById('wallpaperEngineCSS').innerHTML =
        /*css*/
        `
                #lowerPanel {
                    padding-bottom: 0rem;
                    transition: transform 0.5s, padding-bottom 0.5s;
                }

                #lowerPanel:hover, #lowerPanel.lowerPanelUp {
                    padding-bottom: ${(properties.ui_bottom.value / 48) * 3}rem;
                }
            `
    }
    if (properties.ui_volume) {
      MusicPlayer.setVolume(properties.ui_volume.value / 100)
    }
  },
}
export {
  Comments,
  FloatMsgs,
  MusicPlayer,
  NewMessage,
  Popup,
  STATIC_SHOWCASE_MODE,
  Settings,
  Theme,
  TouchKeyboardDetector,
  User,
  XHR,
  bgContainer,
  bindReportButton,
  cancelMessage,
  changeLang,
  clearComments,
  closeImgViewer,
  closePopup,
  commentDiv,
  compareArr,
  debug,
  getArrayNextItem,
  getArrayPrevItem,
  getConfig,
  getCookie,
  getCurrentComment,
  getFileListAsync,
  getFileNameWithoutExt,
  getFirstVisibleComment,
  getFullscreenHorizonalCommentCount,
  getMaxCommentID,
  getMaxCommentTime,
  getMinCommentID,
  getMinCommentTime,
  getRandomIntInclusive,
  hideTopCommentElmnt,
  hoverCalendarEl,
  html2elmnt,
  htmlEscape,
  initCommentReplyQuote,
  insertComment,
  installPrompt,
  isEmail,
  isFullscreen,
  isInStandaloneMode,
  lastBgImgs,
  lastClickEvent,
  loadComments,
  loadNewerComments,
  loadOlderComments,
  loadTimeline,
  loadUserInfo,
  loadingIndicator,
  loadingIndicatorBefore,
  logErr,
  lowerPanel,
  maxTimelineTime,
  msgBgCount,
  msgBgInfo,
  newComment,
  obj2queryString,
  playBG,
  previewLocalImgs,
  readFile,
  refreshCommentActions,
  resizeImg,
  seekComment,
  sendMessage,
  setConfig,
  setCookie,
  setHoverCalendarActiveDay,
  setOneTimeCSS,
  setTimelineActiveMonth,
  setTodayCommentCount,
  showPopup,
  showTimelineElmnt,
  shuffleArray,
  toggleFullscreen,
  toggleTimeline,
  toggleTopComment,
  topComment,
  viewImg,
}
