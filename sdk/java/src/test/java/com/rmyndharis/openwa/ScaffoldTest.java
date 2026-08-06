package com.rmyndharis.openwa;

import static org.junit.jupiter.api.Assertions.assertNotNull;

import com.google.gson.Gson;
import org.junit.jupiter.api.Test;

class ScaffoldTest {
    @Test
    void gsonIsOnTheClasspath() {
        assertNotNull(new Gson().toJson(new int[] {1, 2, 3}));
    }
}
