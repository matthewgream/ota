#!/bin/bash
set -e

#################################################################################################################

HTTP_SERVER="192.168.0.254:9080"

NETWORK_INTERFACE=end0
SERIAL_NO=$(cat /proc/cpuinfo | grep Serial | cut -d ':' -f 2 | tr -d ' ' | tail -c 9)
BOOT_LOCATION="/boot/firmware"
INITRAMFS="$BOOT_LOCATION/initramfs-recovery.gz"
BOOT_FILES=(
   "start4.elf"
   "fixup4.dat"
   "kernel8.img"
   "bcm2711-rpi-4-b.dtb"
   "$INITRAMFS"
)

#IMAGE_SOURCE="/dev/mmcblk0"
#CHUNK_SIZE=10
IMAGE_SOURCE="./test.img"
CHUNK_SIZE=2
IMAGE_FILENAME="image"
COMPRESSOR_PROGRAM="xz"
COMPRESSOR_EXTENSION="xz"
COMPRESSOR_OPTIONS="-9"
DECOMPRESSOR_PROGRAM="xz"
DECOMPRESSOR_OPTIONS="-d"

#################################################################################################################

if ! command -v $COMPRESSOR_PROGRAM >/dev/null; then
    echo "ERROR: '$COMPRESSOR_PROGRAM' tool not found"
    exit 1
fi
if ! command -v curl >/dev/null; then
    echo "ERROR: 'curl' tool not found"
    exit 1
fi

#################################################################################################################

create_ramfs() {
   echo "CREATE: initramfs"

   local TEMP_DIR=$(mktemp -d)
   trap 'rm -rf "$TEMP_DIR"' EXIT

   echo "CREATE: building:"

   mkdir -p "$TEMP_DIR"/{bin,sbin,proc,sys,dev,etc,lib,usr/{bin,sbin}}

   BINS="busybox ip dd sync mount umount reboot wget $DECOMPRESSOR_PROGRAM"
   if [ -f /bin/busybox ]; then
       cp /bin/busybox "$TEMP_DIR/bin/"
       pushd "$TEMP_DIR/bin" > /dev/null
       for tool in ash sh mount umount sync dd; do
           ln -s busybox $tool
       done
           popd > /dev/null
   fi
   for bin in $BINS; do
       if ! [[ "$bin" = "busybox" ]]; then
           if BINPATH=$(which $bin); then
               cp "$BINPATH" "$TEMP_DIR/bin/"
               ldd "$BINPATH" | grep "=>" | sed 's/.*=>[[:blank:]]*\([^[:blank:]]*\).*/\1/' | while read lib; do
                   if [ -f "$lib" ]; then
                       mkdir -p "$TEMP_DIR$(dirname $lib)"
                       cp "$lib" "$TEMP_DIR$(dirname $lib)/"
                   fi
               done
           fi
       fi
   done

   cat > "$TEMP_DIR/init" << 'EOF'
#!/bin/sh
set -e
export PATH=/bin:/sbin:/usr/bin:/usr/sbin
mount -t proc none /proc
mount -t sysfs none /sys
mount -t devtmpfs none /dev
ip link set $NETWORK_INTERFACE up
SERIAL_NO=$(cat /proc/cpuinfo | grep Serial | cut -d ':' -f 2 | tr -d ' ' | tail -c 9)
wget -q -O- "http://192.168.0.254:9080/$SERIAL_NO/$IMAGE_FILENAME.$COMPRESSOR_EXTENSION" | $DECOMPRESSOR_PROGRAM $DECOMPRESSOR_OPTIONS | dd of=/dev/mmcblk0 bs=4M || exec /bin/sh
sync
reboot -f
EOF
   chmod +x "$TEMP_DIR/init"

   pushd "$TEMP_DIR" > /dev/null
   find . | cpio -H newc -o | gzip > "$INITRAMFS"

   echo "CREATE: created:"
   ls -l "$INITRAMFS"
   gzip -d -c "$INITRAMFS" | cpio -tv
   popd > /dev/null
}

#################################################################################################################

upload_files() {
   echo "UPLOAD: files"

   local TEMP_DIR=$(mktemp -d)
   trap 'rm -rf "$TEMP_DIR"' EXIT

   cat > "$TEMP_DIR/config.txt" << EOF
enable_uart=1
arm_64bit=1
initramfs initramfs-recovery.gz followkernel
EOF
   cat > "$TEMP_DIR/cmdline.txt" << EOF
console=tty1 ip=192.168.0.253::192.168.0.1:255.255.255.0:rpi:$NETWORK_INTERFACE:off
EOF

   echo "UPLOAD: starting, interface=$NETWORK_INTERFACE, serial=$SERIAL_NO"

   upload_file() {
      local src_file=$1
      local dst_file=$2
      if [ -f "$src_file" ]; then
          local bytes=$(stat -c%s "$src_file")
          local hash=$(sha256sum < "$src_file" | cut -d' ' -f1)
          echo "UPLOAD: uploading $src_file to $dst_file, bytes=$bytes, hash=$hash"
          local response=$(curl -f -X PUT \
                    -H "Content-Type: application/octet-stream" \
                   --data-binary @"$src_file" "http://$HTTP_SERVER/$dst_file" 2>&1)
          if [ $? -ne 0 ] || ! echo "$response" | grep -qi "success"; then
              echo "UPLOAD: error uploading $src_file"
              [ -n "$response" ] && echo "$response"
              return 1
          fi
      else
          echo "UPLOAD: warning: $src_file not found"
          return 1
      fi
   }

   for file in "${BOOT_FILES[@]}"; do
       upload_file "$BOOT_LOCATION/${file##*/}" "$SERIAL_NO/${file##*/}" || exit 1
   done

   upload_file "$TEMP_DIR/config.txt" "$SERIAL_NO/config.txt" || exit 1
   upload_file "$TEMP_DIR/cmdline.txt" "$SERIAL_NO/cmdline.txt" || exit 1

   echo "UPLOAD: completed to http://$HTTP_SERVER/$SERIAL_NO/"
}

#################################################################################################################

upload_image() {
        echo "UPLOAD: image"

    HASH_FILE=$(mktemp)
    DATA_FILE=$(mktemp)
    VARS_FILE=$(mktemp)
    trap 'rm -f "$HASH_FILE" "$DATA_FILE" "$VARS_FILE"' SIGINT SIGTERM EXIT
    declare total_hash=""
    declare -i total_bytes=0

    upload_image_chunks() {
        local chunk_bytes_max=$((CHUNK_SIZE * 1024 * 1024))
        local chunk_bytes=$((CHUNK_SIZE * 1024 * 1024))
        local chunk=0

        while [ "$chunk_bytes" -eq "$chunk_bytes_max" ]; do
            echo -n "UPLOAD: sending, chunk=$chunk, final=0, "
            response=$((dd bs=$chunk_bytes_max count=1 iflag=fullblock 2>"$DATA_FILE") | \
                    tee >(sha256sum | cut -d' ' -f1 > $HASH_FILE) |
                    curl -s -S -X PUT \
                            -H "Content-Type: application/octet-stream" \
                            --data-binary @- \
                            "http://$HTTP_SERVER/$SERIAL_NO/$IMAGE_FILENAME.$COMPRESSOR_EXTENSION/chunked?chunk=$chunk" 2>&1)
            if ! echo "$response" | grep -qi "success"; then
                    echo -n "error"
                    [ -n "$response" ] && echo -n "='$response'"
                    echo ""
                    exit -1
            fi

            chunk_bytes=$(cat "$DATA_FILE" | grep "bytes" | awk '{print $1}')
            if [ -z "$chunk_bytes" ] || [ "$chunk_bytes" -eq 0 ]; then
                exit -1
            fi
                chunk_hash=$(cat "$HASH_FILE")

            echo "bytes=$chunk_bytes, hash=$chunk_hash"

            total_bytes=$((total_bytes + bytes))
            total_hash=$([ "$chunk" == 0 ] && echo "$chunk_hash" || echo -n "${total_hash}${chunk_hash}" | sha256sum | cut -d' ' -f1)
            echo "$total_bytes" > "$VARS_FILE"
            echo "$total_hash" >> "$VARS_FILE"

            chunk=$((chunk + 1))
        done

        echo -n "UPLOAD: sending, chunk=$chunk, final=1"
        response=$(curl -s -S -X PUT \
            "http://$HTTP_SERVER/$SERIAL_NO/$IMAGE_FILENAME.$COMPRESSOR_EXTENSION/chunked?chunk=$chunk&final=1&hash=$total_hash" 2>&1)
            if ! echo "$response" | grep -qi "success"; then
            echo -n "error"
            [ -n "$response" ] && echo -n "='$response'"
            echo ""
            exit -1
            fi
        echo ""
    }

        echo "UPLOAD: starting, source=$IMAGE_SOURCE, chunk_size=${CHUNK_SIZE}MB, serial=$SERIAL_NO, filename=$IMAGE_FILENAME.$COMPRESSOR_EXTENSION"
        dd if="$IMAGE_SOURCE" bs=1M status=none | \
                $COMPRESSOR_PROGRAM $COMPRESSOR_OPTIONS | \
                upload_image_chunks
        total_bytes=$(head -n1 "$VARS_FILE")
        total_hash=$(tail -n1 "$VARS_FILE")
        echo "UPLOAD: complete, bytes=$total_bytes, hash=$total_hash"
}

#################################################################################################################

create_ramfs
echo "***"
upload_files
echo "***"
upload_image
echo "***"

#################################################################################################################


