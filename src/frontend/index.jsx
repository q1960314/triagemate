import React, { useEffect, useState } from 'react';
import ForgeReconciler, {
  Text,
  Button,
  Heading,
  Lozenge,
  Tag,
  TagGroup,
  User,
  Stack,
  Box,
  Spinner,
  SectionMessage,
  ErrorMessage,
  Inline,
  List,
  ListItem,
  useProductContext,
} from '@forge/react';
import { invoke } from '@forge/bridge';

// Lozenge colour per Jira priority, so the suggested priority reads at a glance.
const PRIORITY_APPEARANCE = {
  Highest: 'removed',
  High: 'moved',
  Medium: 'inprogress',
  Low: 'new',
  Lowest: 'default',
};

const App = () => {
  // The issue this panel is open on. useProductContext is the UI Kit way to
  // read the product context; the issue key lives under extension.issue.
  const context = useProductContext();
  const issueKey = context && context.extension && context.extension.issue
    ? context.extension.issue.key
    : null;

  const [suggestion, setSuggestion] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [applying, setApplying] = useState(false);
  const [applied, setApplied] = useState(null);
  const [applyError, setApplyError] = useState(null);

  // Ask the backend for a fresh four-item suggestion for the open issue.
  const loadSuggestion = async () => {
    if (!issueKey) {
      return;
    }
    setLoading(true);
    setError(null);
    setApplied(null);
    setApplyError(null);
    try {
      const result = await invoke('getSuggestion', { issueKey });
      if (result && result.ok) {
        setSuggestion(result.suggestion);
      } else {
        setError((result && result.error) || 'The suggestion could not be generated.');
      }
    } catch (err) {
      setError(err && err.message ? err.message : 'The suggestion could not be generated.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadSuggestion();
  }, [issueKey]);

  // Write the confirmed suggestion back to the issue: priority, labels and
  // assignee. The backend reads the issue back afterwards, so what is shown
  // here is the verified new state, not just what was requested.
  const applySuggestion = async () => {
    if (!suggestion) {
      return;
    }
    setApplying(true);
    setApplyError(null);
    try {
      const result = await invoke('applySuggestion', {
        issueKey,
        priority: suggestion.priority.value,
        labels: suggestion.labels.values,
        assigneeAccountId: suggestion.assignee.accountId || undefined,
      });
      if (result && result.ok) {
        setApplied(result);
      } else {
        setApplyError((result && result.error) || 'The suggestion could not be applied.');
      }
    } catch (err) {
      setApplyError(err && err.message ? err.message : 'The suggestion could not be applied.');
    } finally {
      setApplying(false);
    }
  };

  if (!issueKey) {
    return (
      <Stack space="space.200">
        <Text>Open this panel on a Jira issue to see its triage suggestion.</Text>
      </Stack>
    );
  }

  if (loading && !suggestion) {
    return (
      <Stack space="space.200">
        <Inline space="space.100" alignBlock="center">
          <Spinner size="medium" />
          <Text>正在生成分诊建议…</Text>
        </Inline>
      </Stack>
    );
  }

  if (error && !suggestion) {
    return (
      <Stack space="space.200">
        <ErrorMessage>{error}</ErrorMessage>
        <Button onClick={loadSuggestion}>重试</Button>
      </Stack>
    );
  }

  if (!suggestion) {
    return (
      <Stack space="space.200">
        <Text>暂无分诊建议。</Text>
      </Stack>
    );
  }

  const assignee = suggestion.assignee;
  const verified = applied && applied.verified;

  return (
    <Stack space="space.200">
      <Heading as="h3">分诊建议 · {suggestion.issueKey}</Heading>
      <Text>{suggestion.summary}</Text>

      <Box>
        <Text>优先级</Text>
        <Inline space="space.100" alignBlock="center">
          <Lozenge appearance={PRIORITY_APPEARANCE[suggestion.priority.value] || 'default'}>
            {suggestion.priority.value}
          </Lozenge>
          {suggestion.currentPriority && suggestion.currentPriority !== suggestion.priority.value ? (
            <Text>（当前：{suggestion.currentPriority}）</Text>
          ) : null}
        </Inline>
        <Text>{suggestion.priority.reason}</Text>
      </Box>

      <Box>
        <Text>标签</Text>
        {suggestion.labels.values.length > 0 ? (
          <TagGroup>
            {suggestion.labels.values.map((label) => (
              <Tag key={label} text={label} />
            ))}
          </TagGroup>
        ) : (
          <Text>无建议标签</Text>
        )}
        <Text>{suggestion.labels.reason}</Text>
      </Box>

      <Box>
        <Text>建议负责人</Text>
        {assignee.accountId ? (
          <User accountId={assignee.accountId} />
        ) : (
          <Text>无人选</Text>
        )}
        <Text>{assignee.reason}</Text>
      </Box>

      <Box>
        <Text>置信度：{suggestion.confidence.level}</Text>
        <List>
          {suggestion.confidence.evidence.map((item, index) => (
            <ListItem key={index}>
              <Text>{item}</Text>
            </ListItem>
          ))}
        </List>
      </Box>

      {applied && verified ? (
        <SectionMessage appearance="confirmation" title="建议已应用">
          <Text>
            已核对写回结果：优先级 {verified.priority}；标签 {verified.labels.length > 0 ? verified.labels.join('、') : '无'}；负责人 {verified.assignee ? verified.assignee.displayName : '未设置'}。
          </Text>
        </SectionMessage>
      ) : null}

      {applyError ? (
        <ErrorMessage>{applyError}</ErrorMessage>
      ) : null}

      <Inline space="space.100">
        <Button appearance="primary" onClick={applySuggestion} isDisabled={applying || loading}>
          {applying ? '应用中…' : '应用建议'}
        </Button>
        <Button onClick={loadSuggestion} isDisabled={applying || loading}>
          {loading ? '评估中…' : '重新评估'}
        </Button>
      </Inline>
    </Stack>
  );
};

ForgeReconciler.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
