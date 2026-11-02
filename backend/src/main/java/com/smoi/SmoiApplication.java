package com.smoi;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.ConfigurationPropertiesScan;

@SpringBootApplication
@ConfigurationPropertiesScan
public class SmoiApplication {

    public static void main(String[] args) {
        SpringApplication.run(SmoiApplication.class, args);
    }
}
