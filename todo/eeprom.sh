#!/bin/bash

check_and_update_eeprom() {

   local REQUIRED_SETTINGS=(
       "BOOT_UART=0"
       "BOOT_ORDER=0xf21"
       "TFTP_IP=192.168.0.254"
       "TFTP_PREFIX=0"
   )

   local CURRENT_CONFIG=$(rpi-eeprom-config)
   local NEEDS_UPDATE=0

   for setting in "${REQUIRED_SETTINGS[@]}"; do
       local key=$(echo $setting | cut -d= -f1)
       local value=$(echo $setting | cut -d= -f2)
       local current_value=$(echo "$CURRENT_CONFIG" | grep "^$key=" | cut -d= -f2)
       if [ "$current_value" != "$value" ]; then
           echo "EEPROM: $key needs update: current=$current_value required=$value"
           NEEDS_UPDATE=1
       fi
   done

   if [ $NEEDS_UPDATE -eq 1 ]; then
       echo "EEPROM: updating configuration..."
       local TEMP_CONFIG=$(mktemp)
       echo "$CURRENT_CONFIG" > "$TEMP_CONFIG"
       for setting in "${REQUIRED_SETTINGS[@]}"; do
           local key=$(echo $setting | cut -d= -f1)
           local value=$(echo $setting | cut -d= -f2)
           sed -i "s/^$key=.*/$key=$value/" "$TEMP_CONFIG"
           if ! grep -q "^$key=" "$TEMP_CONFIG"; then
               echo "$key=$value" >> "$TEMP_CONFIG"
           fi
       done

        cat $TEMP_CONFIG

       if rpi-eeprom-config --apply "$TEMP_CONFIG"; then
           echo "EEPROM: update successful"
           rm "$TEMP_CONFIG"
           return 0
       else
           echo "EEPROM: update failed"
           rm "$TEMP_CONFIG"
           return 1
       fi


   else
       echo "EEPROM: configuration is correct"
       return 0
   fi
}

check_and_update_eeprom
