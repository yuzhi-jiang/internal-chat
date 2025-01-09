const CONNECTION_STATES = {
  DISCONNECTED: 'disconnected',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  FAILED: 'failed',
  CLOSED: 'closed'
};

connOption = 
{ 
  ordered: true, 
  maxRetransmits: 10, // 最大重传次数
  bufferedAmountLowThreshold: 1024 * 16 // 设置缓冲区低阈值为 16KB
}
class XChatUser {
  id = null;
  isMe = false;
  nickname = null;

  rtcConn = null;
  connAddressTarget = null;
  connAddressMe = null;
  chatChannel = null;
  candidateArr = [];

  onicecandidate = () => { };
  onmessage = () => { };
  onReviceFile = () => { };
  onConnectionStateChange = () => { };

  receivedSize = 0;
  receivedChunks = [];
  fileInfo = null;

  #isTransferCancelled = false;

  async createConnection() {
    this.rtcConn = new RTCPeerConnection({ iceServers: [] });
    this.chatChannel = this.rtcConn.createDataChannel('chat',  connOption);
    this.dataChannel_initEvent()
    // this.dataChannel.onopen = () => console.log('DataChannel is open');
    // this.dataChannel.onclose = () => console.log('DataChannel is closed');
    const offer = this.rtcConn.createOffer()
    await this.rtcConn.setLocalDescription(offer)
    this.connAddressMe = this.rtcConn.localDescription;

    this.rtcConn.onicecandidate = event => {
      if (event.candidate) {
        this.candidateArr.push(event.candidate);
        this.onicecandidate(event.candidate, this.candidateArr);
      }
    };

    this.rtcConn.onconnectionstatechange = () => {
      console.log(`Connection state changed: ${this.rtcConn.connectionState}`);
      this.onConnectionStateChange(this.rtcConn.connectionState);
      if (this.rtcConn.connectionState === 'failed') {
        console.log('Connection failed, attempting to reconnect...');
        this.reconnect();
      }
    };

    return this;
  }

  closeConnection() {
    if (this.rtcConn) {
      this.rtcConn.onconnectionstatechange = null;
      this.rtcConn.close();
    }
    this.rtcConn = null;
    this.chatChannel = null;
    this.connAddressTarget = null;
    this.connAddressMe = null;
    this.onicecandidate = () => { };
    this.onConnectionStateChange(CONNECTION_STATES.CLOSED);
  }

  async connectTarget(target) {
    if (!target) {
      throw new Error('connAddressTarget is null');
    }
    if (this.isMe || !this.id) {
      return this;
    }

    if (this.rtcConn) {
      this.closeConnection();
    }

    this.rtcConn = new RTCPeerConnection({ iceServers: [] });

    this.rtcConn.onicecandidate = event => {
      if (event.candidate) {
        this.candidateArr.push(event.candidate);
        this.onicecandidate(event.candidate, this.candidateArr);
      }
    };
    this.rtcConn.ondatachannel = (event) => {
      if (event.channel) {
        this.chatChannel = event.channel;
        this.dataChannel_initEvent();
      }
    };
    this.connAddressTarget = new RTCSessionDescription({ type: 'offer', sdp: target});
    await this.rtcConn.setRemoteDescription(this.connAddressTarget);
    
    this.connAddressMe = await this.rtcConn.createAnswer();
    this.rtcConn.setLocalDescription(this.connAddressMe);

    this.rtcConn.onconnectionstatechange = () => {
      console.log(`Connection state changed: ${this.rtcConn.connectionState}`);
      this.onConnectionStateChange(this.rtcConn.connectionState);
      if (this.rtcConn.connectionState === 'failed') {
        console.log('Connection failed, attempting to reconnect...');
        this.reconnect();
      }
    };

    return this;
  }

  addIceCandidate(candidate) {
    if (!this.rtcConn) {
      return;
    }
    this.rtcConn.addIceCandidate(new RTCIceCandidate(candidate))
  }

  async setRemoteSdp(target) {
    if (this.rtcConn.signalingState === 'have-local-offer' && !this.rtcConn.remoteDescription) {
      // console.log('setRemoteDescription', target);
      try {

        this.rtcConn.setRemoteDescription({ type: 'answer', sdp: target})
        .then(() => console.log('Remote SDP set as answer.'))
        .catch(err => console.error('Error handling answer SDP:', err));
      } catch (err) {
        console.error('Error handling answer SDP:', err);
      }
    } else {
      // console.error('Cannot set answer SDP: signaling state is', peerConnection.signalingState);
    }
  }

  dataChannel_initEvent() {
    // 接收消息
    this.chatChannel.onmessage = e => {
      const message = e.data;
      if (typeof message === 'string') {
        if (message.startsWith('##FILE_S##')) {
          // 文件传输前的头信息
          this.receivedChunks = [];
          this.receivedSize = 0;
          this.fileInfo = JSON.parse(message.substring(10));
        } else if (message === '##FILE_E##') {
        } else {
          this.onmessage(message);
        }
      } else if (this.receivedChunks) {
        if (message instanceof ArrayBuffer) {
          this.receivedChunks.push(message);
        } else if (message instanceof Uint8Array) {
          this.receivedChunks.push(message.buffer);
        } else {
          console.error('unknow message type', message);
        }
        this.receivedSize += message.byteLength;
        console.log(this.fileInfo.size, this.receivedSize, `${Math.floor(this.receivedSize / this.fileInfo.size * 100)}%`);
        if (this.fileInfo.size === this.receivedSize) {
          // 文件传输结束的尾信息
          // console.log(this.receivedChunks);
          let blob = new Blob(this.receivedChunks);
          let url = URL.createObjectURL(blob);
          console.log('finish recive');
          this.onReviceFile({  url, name: this.fileInfo.name });
          blob = null;
          this.receivedChunks = null;
          this.receivedSize = 0;
          this.fileInfo = null;
        }
      }
    };

    this.chatChannel.onopen = () => console.log('chatChannel is open');
    this.chatChannel.onclose = () => console.log('DataChannel is closed');
  }
  checkBufferedAmount() {
    const maxBufferedAmount = 1024 * 64; // 降低最大缓冲区限制到 64KB
    return new Promise(resolve => {
      if (this.chatChannel.bufferedAmount > maxBufferedAmount) {
        // 如果缓冲区超过阈值，等待 bufferedamountlow 事件
        const handleBufferedAmountLow = () => {
          this.chatChannel.removeEventListener('bufferedamountlow', handleBufferedAmountLow);
          resolve();
        };
        this.chatChannel.addEventListener('bufferedamountlow', handleBufferedAmountLow);
      } else {
        // 缓冲区未满，立即解析
        resolve();
      }
    });
  }
  sendFileBytes(file, onProgress) {
    return new Promise((resolve, reject) => {
      const chunkSize = 8 * 1024; // 降低每个块的大小到 8KB
      const totalChunks = Math.ceil(file.size / chunkSize);
      let currentChunk = 0;
      let totalSent = 0;
      let lastProgressUpdate = Date.now();

      const fileReader = new FileReader();
      
      fileReader.onerror = () => {
        reject(new Error('File reading failed'));
      };

      fileReader.onload = async () => {
        try {
          if (this.#isTransferCancelled) {
            return;
          }

          await this.checkBufferedAmount();
          
          if (this.chatChannel.readyState !== 'open') {
            throw new Error('Connection closed');
          }

          this.chatChannel.send(fileReader.result);
          totalSent += fileReader.result.byteLength;

          // 限制进度更新频率，避免过于频繁的UI更新
          const now = Date.now();
          if (now - lastProgressUpdate > 100) { // 每 100ms 最多更新一次
            if (onProgress) {
              onProgress(totalSent, file.size);
            }
            lastProgressUpdate = now;
          }

          currentChunk++;

          if (currentChunk < totalChunks) {
            // 使用 setTimeout 来避免调用栈过深
            setTimeout(() => sendNextChunk(), 0);
          } else {
            if (onProgress) {
              onProgress(totalSent, file.size); // 确保最后一次进度更新
            }
            resolve();
          }
        } catch (e) {
          console.error('Error sending chunk:', e);
          reject(e);
        }
      };

      const sendNextChunk = () => {
        try {
          const start = currentChunk * chunkSize;
          const end = Math.min(start + chunkSize, file.size);
          const chunk = file.slice(start, end);
          fileReader.readAsArrayBuffer(chunk);
        } catch (e) {
          console.error('Error preparing chunk:', e);
          reject(e);
        }
      };

      sendNextChunk();
    });
  }

  async sendFile(fileInfo, file, onProgress) {
    try {
      this.#isTransferCancelled = false; // 重置取消标志
      if (this.chatChannel.readyState !== 'open') {
        throw new Error('Connection not open');
      }

      const fileInfoStr = '##FILE_S##' + JSON.stringify(fileInfo);
      await this.sendMessage(fileInfoStr);
      
      await this.sendFileBytes(file, onProgress);
      
      if (!this.#isTransferCancelled) { // 只有在未取消时才发送结束标记
        await this.sendMessage('##FILE_E##');
      }
    } catch (e) {
      console.error('Send file failed:', e);
      throw e;
    }
  }
  
  async sendMessage(message) {
    if (!this.chatChannel) {
      console.log(this.id, '------chatChannel is null');
      return;
    }
    if (this.chatChannel.readyState === 'open') {
      await this.chatChannel.send(message);
    } else {
      throw new Error('DataChannel is not open');
    }
  }

  // 添加取消传输方法
  cancelTransfer() {
    this.#isTransferCancelled = true;
    if (this.chatChannel) {
      // 关闭并重新创建数据通道，确保传输被中断
      this.chatChannel.close();
      this.createDataChannel();
    }
  }

  // 创建新的数据通道
  createDataChannel() {
    if (this.rtcConn) {
      this.chatChannel = this.rtcConn.createDataChannel('chat', connOption);
      this.dataChannel_initEvent();
    }
  }

  // 添加重连方法
  async reconnect() {
    console.log('Attempting to reconnect...');
    if (this.connAddressTarget) {
      try {
        await this.connectTarget(this.connAddressTarget.sdp);
      } catch (error) {
        console.error('Reconnection failed:', error);
      }
    }
  }

  // 获取当前连接状态
  getConnectionState() {
    if (!this.rtcConn) {
      return CONNECTION_STATES.DISCONNECTED;
    }
    return this.rtcConn.connectionState;
  }

  // 检查是否已连接
  isConnected() {
    return this.rtcConn && this.rtcConn.connectionState === 'connected';
  }
}