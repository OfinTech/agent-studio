"use client";
import { useState } from "react";
import {
  Alert,
  Button,
  Center,
  Container,
  Paper,
  PasswordInput,
  Stack,
  TextInput,
  Title,
} from "@mantine/core";
import { isEmail, isNotEmpty, useForm } from "@mantine/form";
export default function Login() {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const form = useForm({
    initialValues: { email: "", password: "" },
    validate: {
      email: isEmail("Enter a valid email address"),
      password: isNotEmpty("Enter your password"),
    },
  });
  return (
    <Center mih="100dvh" p="md">
      <Container size="xs" w="100%">
        <Paper withBorder p="md">
          <Stack gap="md">
            <Title order={1}>Sign in</Title>
            <form
              noValidate
              onSubmit={form.onSubmit(async (values) => {
                setBusy(true);
                setError("");
                try {
                  const response = await fetch("/api/auth/login", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(values),
                  });
                  const data = await response.json();
                  if (!response.ok) throw new Error(data.error);
                  window.location.assign("/workflows");
                } catch (e) {
                  setError((e as Error).message);
                  setBusy(false);
                }
              })}
            >
              <Stack gap="md">
                <TextInput
                  label="Email address"
                  type="email"
                  autoComplete="username"
                  required
                  {...form.getInputProps("email")}
                />
                <PasswordInput
                  label="Password"
                  // Mantine 9.6.1 forwards this to the native password input.
                  aria-invalid={Boolean(form.errors.password) || undefined}
                  autoComplete="current-password"
                  required
                  {...form.getInputProps("password")}
                />
                {error && (
                  <Alert color="red" role="alert">
                    {error}
                  </Alert>
                )}
                <Button type="submit" loading={busy} fullWidth>
                  Sign in
                </Button>
              </Stack>
            </form>
          </Stack>
        </Paper>
      </Container>
    </Center>
  );
}
