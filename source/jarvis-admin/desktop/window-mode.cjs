'use strict'

function minimizeDisposition({ authenticated, currentMode }) {
  return authenticated && currentMode !== 'overlay' ? 'overlay' : 'minimize'
}

module.exports = { minimizeDisposition }
