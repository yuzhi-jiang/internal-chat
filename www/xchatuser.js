connOption = 
{ 
  ordered: true, 
  maxRetransmits: 10, // 最大重传次数
  bufferedAmountLowThreshold: 1024 * 16 // 设置缓冲区低阈值为 16KB
}
class XChatUser {
  id = null;
  isMe = false;

  rtcConn = null;
  connAddressTarget = null;
  connAddressMe = null;
  chatChannel = null;
  candidateArr = [];

  onicecandidate = () => { };
  onmessage = () => { };
  onReviceFile = () => { };


  receivedSize = 0;
  receivedChunks = [];
  fileInfo = null;

  

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

    return this;
  }

  closeConnection() {
    if (this.rtcConn) {
      this.rtcConn.close();
    }
    this.rtcConn = null;
    this.chatChannel = null;
    this.connAddressTarget = null;
    this.connAddressMe = null;
    this.onicecandidate = () => { };
  }

  async connectTarget(target) {
    if (!target) {
      throw new Error('connAddressTarget is null');
    }
    if (this.isMe || !this.id) {
      return this;
    }
    if (this.rtcConn) {
      this.rtcConn.close();
      this.rtcConn = null;
      return this;
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
    const maxBufferedAmount = 1024 * 128; // 设置最大缓冲区限制（例如 256KB）
    if (this.chatChannel.bufferedAmount >= maxBufferedAmount) {
      // console.log('Data channel is full, waiting...');
      // 如果缓冲区满了，暂停发送
      return false;
    } else {
      // 缓冲区未满，可以继续发送
      return true;
    }
  }
  sendFileBytes(file) {
    return new Promise((resolve, reject) => {
      const chunkSize = 16 * 1024; // 每次发送 32KB
      const totalChunks = Math.ceil(file.size / chunkSize);
      let currentChunk = 0;

      const fileReader = new FileReader();
      
      // 文件读取完成后的处理
      fileReader.onload = async () => {
        // `fileReader.result` 包含当前块的数据
        try {

          while(!this.checkBufferedAmount()) {
            await new Promise((resolve, reject) => {
              setTimeout(() => {
                resolve();
              }, 100);
            });
          }
          this.chatChannel.send(fileReader.result); // 发送数据
        } catch (e) {
          console.error(e);
          reject();
        }
        console.log(`${currentChunk + 1}/${totalChunks}(${Math.floor((currentChunk + 1) / totalChunks * 100)}%)`);
        currentChunk++;

        // 如果还有下一个块，继续发送
        if (currentChunk < totalChunks) {
          sendNextChunk();
        } else {
          console.log('File sent successfully.');
          resolve();
        }
      };

      function sendNextChunk() {
        const start = currentChunk * chunkSize;
        const end = Math.min(start + chunkSize, file.size);
        try {
          const chunk = file.slice(start, end);
          fileReader.readAsArrayBuffer(chunk); // 读取当前块
        } catch (e) {
          console.error(e);
          reject();
        }
      }

      sendNextChunk(); // 开始发送
    });
  }

  async sendFile(fileInfo, file) {
    const fileInfoStr = '##FILE_S##' + JSON.stringify(fileInfo);
    await this.sendMessage(fileInfoStr);
    await this.sendFileBytes(file);
    await this.sendMessage('##FILE_E##');
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
}